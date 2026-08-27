import { z } from 'zod';
import { db } from '../db/database';
import { LLMService } from './llm';
import { formatVisualLockTokens } from './reference_generation_policy';
import { CHARACTER_VISUAL_LOCK_RULES } from './prompts';
import {
  createSceneVersion,
  syncActiveVersionFromScene,
} from './scene_versions';
import { sanitizeVisualPrompt } from './visual_prompt_sanitizer';
import {
  assertChapterUniqueness,
  formatUniquenessFailure,
} from './visual_prompt_uniqueness';
import {
  assertChapterShotQuota,
  chapterLikelyHasKeyProps,
  formatShotQuotaFailure,
  mapShotTypeToIntent,
} from './shot_intent_quota';
import { compileNegativePrompt } from './negative_prompt_compiler';
import {
  compilePonyPrompt,
  type CharacterLockRef,
} from './pony_prompt_compiler';
import { packShotSpec, ShotIntentSchema, SubjectScaleSchema } from '../schemas/shot_contract';

/** LLM returns contracts only — server compiles visual_prompt. */
const SceneContractRewriteSchema = z.object({
  scenes: z.array(z.object({
    scene_id: z.coerce.number().int(),
    shot_type: z.string().trim().min(2).max(80),
    camera_angle: z.string().trim().min(2).max(80).optional().default('Eye-level'),
    shot_intent: ShotIntentSchema.optional(),
    location: z.string().trim().min(2).max(240),
    primary_action: z.string().trim().min(2).max(240),
    primary_subject: z.string().trim().max(240).optional().nullable(),
    visible_subjects: z.array(z.string().trim().min(1).max(120)).max(6).optional().default([]),
    key_props: z.array(z.string().trim().min(1).max(120)).max(2).optional().default([]),
    subject_scale: SubjectScaleSchema.optional(),
    uniqueness_key: z.string().trim().min(2).max(240).optional(),
    must_not: z.array(z.string().trim().min(1).max(120)).optional().default([]),
  })).min(1),
});

const parseVisualTags = (value: unknown): any => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};

/** Appearance lock lines for rewrite / timeline prompts — visual_tags only. */
export const buildCharacterVisualLockBible = (
  characters: any[],
  chapterId?: string | number | null
): Array<{ name: string; role?: string; visual_lock: string }> => {
  return (characters || []).map((character) => {
    const visualTags = parseVisualTags(character.visual_tags);
    const visual_lock = formatVisualLockTokens(visualTags, { chapterId });
    return {
      name: String(character.name || '').trim() || 'unnamed',
      role: character.role ? String(character.role) : undefined,
      visual_lock: visual_lock || '(none — do not invent appearance tags)',
    };
  });
};

export const buildSceneVisualPromptRewritePrompt = (
  chapter: any,
  scenes: any[],
  characters: any[],
  bannedUniquenessKeys: string[] = []
): string => {
  // Do NOT include current_visual_prompt — few-shot copying caused chapter-2 clones.
  const scenePayload = scenes.map((scene) => {
    let shotSpec: any = {};
    try {
      shotSpec =
        typeof scene.shot_spec === 'string'
          ? JSON.parse(scene.shot_spec || '{}')
          : scene.shot_spec || {};
    } catch {
      shotSpec = {};
    }
    return {
      scene_id: Number(scene.id),
      index: Number(scene.index),
      narration: scene.narration || '',
      dialogue: scene.dialogue || '',
      current_shot_type: scene.shot_type || '',
      existing_shot_spec: shotSpec,
    };
  });
  const characterBible = buildCharacterVisualLockBible(characters, chapter?.id);

  return `You are a storyboard contract editor. Fill a Shot Contract for every scene_id.
The server compilePonyPrompt will build final Pony tags — do NOT write visual_prompt prose.

Mandatory rules:
1. Return exactly one item for every scene_id, same order. JSON only.
2. Preserve plot/props/setting/action from chapter text + narration/dialogue. Do not invent events.
3. Required per scene: location, primary_action, shot_type. Optional: shot_intent, key_props (≤2), subject_scale, uniqueness_key, must_not, primary_subject, camera_angle.
4. ${CHARACTER_VISUAL_LOCK_RULES}
5. uniqueness_key = location + action + primary prop. Must differ from neighbors and from banned keys: ${JSON.stringify(bannedUniquenessKeys)}.
6. Never copy a previous scene's contract. Never output visual_prompt or negative_prompt fields.
7. shot_intent ∈ establish|wide-action|medium-action|insert|reaction|overhead-map|payoff.
8. Output example:
{"scenes":[{"scene_id":104,"shot_type":"Insert Shot","shot_intent":"insert","camera_angle":"Eye-level","location":"european arcade","primary_action":"paw presses music-note button","key_props":["miniature park map","music-note button"],"subject_scale":"absent","primary_subject":"paw-only","uniqueness_key":"arcade | press button | map"}]}

Chapter title: ${chapter.title || ''}
Original chapter text:
${chapter.content || ''}

Character bible (Visual Lock only — never invent kitten/1girl/wolf):
${JSON.stringify(characterBible, null, 2)}

Scenes (contracts only; old visual_prompt intentionally omitted):
${JSON.stringify(scenePayload, null, 2)}`;
};

const normalize = (value: string): string => String(value || '').replace(/\s+/g, ' ').trim();

const PORTRAIT_NEGATIVE_TOKENS = [
  'centered portrait', 'portrait', 'front view', 'looking at viewer', 'eye contact',
  'close-up face', 'face close-up', 'close-up', 'headshot', 'studio background',
  'gradient background', 'isolated animal', 'character sheet', 'fashion pose',
  'symmetrical portrait', 'oversized animal', 'full-frame animal'
];

const normalizeNegativePrompt = (value: string): string => {
  const tokens = normalize(value)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !PORTRAIT_NEGATIVE_TOKENS.includes(token.toLowerCase()));
  const safeBase = [
    '2animals', 'multiple animals', 'duplicate animal', 'extra cat',
    'wolf', 'fox', 'dog', 'human', 'person', 'man', 'woman', 'boy', 'girl',
    'humanoid', 'anthro', 'bipedal', 'clothes', 'text', 'caption', 'watermark'
  ];
  return [...new Set([...safeBase, ...tokens])].join(', ');
};

/**
 * Normalize a rewritten visual_prompt for DB storage.
 * Runs the deterministic sanitizer (non-visual delete + metaphor grounding),
 * then persists only the cleaned visual string. Does not prepend project prefixes.
 * shotType is kept for call-site compatibility but is not injected.
 * Negative extras from metaphors are returned via normalizeVisualPromptWithExtras.
 */
export const normalizeVisualPrompt = (value: string, _shotType?: string): string => {
  return normalizeVisualPromptWithExtras(value, _shotType).visual_prompt;
};

export const normalizeVisualPromptWithExtras = (
  value: string,
  _shotType?: string
): { visual_prompt: string; negative_extras: string[] } => {
  const sanitized = sanitizeVisualPrompt(value);
  return {
    visual_prompt: sanitized.visual_prompt,
    negative_extras: sanitized.negative_extras,
  };
};

const parseShotSpec = (raw: unknown): any => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
};

const prepareCompiledScenes = (
  scenes: any[],
  contracts: z.infer<typeof SceneContractRewriteSchema>['scenes'],
  chapterContent: string,
  characterLocks: CharacterLockRef[]
) => {
  const expectedIds = scenes.map((scene: any) => Number(scene.id));
  const byId = new Map(contracts.map((scene) => [scene.scene_id, scene]));
  const missing = expectedIds.filter((id) => !byId.has(id));
  const unexpected = [...byId.keys()].filter((id) => !expectedIds.includes(id));
  if (byId.size !== contracts.length || missing.length || unexpected.length) {
    throw new Error(
      `Local visual prompt coverage mismatch (missing=${missing.join(',') || 'none'}; unexpected=${unexpected.join(',') || 'none'})`
    );
  }

  const prepared = scenes.map((scene: any) => {
    const contract = byId.get(Number(scene.id))!;
    const shot_intent =
      contract.shot_intent || mapShotTypeToIntent(contract.shot_type, contract.primary_action);
    const visible_subjects =
      (contract as any).visible_subjects
      || parseShotSpec(scene.shot_spec)?.visible_subjects
      || [];
    const compiled = compilePonyPrompt(
      {
        shot_intent,
        shot_type: contract.shot_type,
        location: contract.location,
        primary_action: contract.primary_action,
        primary_subject: contract.primary_subject,
        visible_subjects,
        key_props: contract.key_props,
        subject_scale: contract.subject_scale,
        must_not: contract.must_not,
      },
      characterLocks
    );
    const sanitized = sanitizeVisualPrompt(compiled.visual_prompt);
    const compiledNegative = compileNegativePrompt({
      shot_type: contract.shot_type,
      shot_intent: compiled.shot_intent,
      visual_prompt: sanitized.visual_prompt,
      location: contract.location,
      key_props: contract.key_props,
      character_lock: characterLocks.map((ref) => ref.lock).join(', '),
      identity_mode: 'auto',
    });
    const uniqueness_key = contract.uniqueness_key || null;
    const shot_spec = packShotSpec({
      shot_intent: compiled.shot_intent,
      location: contract.location,
      primary_action: contract.primary_action,
      primary_subject: contract.primary_subject,
      visible_subjects,
      key_props: contract.key_props,
      subject_scale: contract.subject_scale,
      uniqueness_key,
      must_not: contract.must_not,
      shot_type: contract.shot_type,
    });
    return {
      scene_id: Number(scene.id),
      has_asset: Boolean(scene.asset_url),
      visual_prompt: sanitized.visual_prompt,
      negative_prompt: normalizeNegativePrompt(
        [compiledNegative, ...compiled.negative_extras, ...sanitized.negative_extras]
          .filter(Boolean)
          .join(', ')
      ),
      shot_type: normalize(contract.shot_type),
      camera_angle: normalize(contract.camera_angle || scene.camera_angle || 'Eye-level'),
      uniqueness_key,
      shot_spec,
      shot_intent: compiled.shot_intent,
    };
  });

  const uniqueness = assertChapterUniqueness(
    prepared.map((row) => ({
      visual_prompt: row.visual_prompt,
      uniqueness_key: row.uniqueness_key,
    }))
  );
  const quota = assertChapterShotQuota(
    prepared.map((row) => ({
      shot_type: row.shot_type,
      shot_intent: row.shot_intent,
      visual_prompt: row.visual_prompt,
    })),
    { hasKeyProps: chapterLikelyHasKeyProps(chapterContent) }
  );

  let gateError: string | null = null;
  if (uniqueness.ok === false) gateError = formatUniquenessFailure(uniqueness.violation);
  else if (quota.ok === false) gateError = formatShotQuotaFailure(quota.violation);

  return { prepared, uniqueness, quota, gateError };
};

export const regenerateSceneVisualPromptsForChapter = async (chapterId: string) => {
  const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', chapterId);
  if (!chapter) throw new Error('Chapter not found');
  const scenes = await db.all(
    'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC',
    chapterId
  );
  if (!scenes.length) throw new Error('Chapter has no storyboard scenes');
  const characters = await db.all(
    'SELECT name, role, description, visual_tags FROM character WHERE project_id = ? ORDER BY id ASC',
    chapter.project_id
  );

  const chapterContent = String(chapter.content || '');
  const characterLocks: CharacterLockRef[] = buildCharacterVisualLockBible(
    characters,
    chapter.id
  )
    .filter((row) => row.visual_lock && !/^\(none/i.test(row.visual_lock))
    .map((row) => {
      const tags = parseVisualTags(
        characters.find((c: any) => String(c.name) === row.name)?.visual_tags
      );
      const aliases = Array.isArray(tags?.aliases)
        ? tags.aliases.map((a: unknown) => String(a || '').trim()).filter(Boolean)
        : [];
      return { name: row.name, aliases, lock: row.visual_lock };
    });

  // Prefer existing shot_spec contracts when present — compile without LLM few-shot.
  const allHaveSpec = scenes.every((scene: any) => {
    const spec = parseShotSpec(scene.shot_spec);
    return Boolean(spec?.location && spec?.primary_action);
  });

  let pack: ReturnType<typeof prepareCompiledScenes>;

  if (allHaveSpec) {
    const contracts = scenes.map((scene: any) => {
      const spec = parseShotSpec(scene.shot_spec);
      return {
        scene_id: Number(scene.id),
        shot_type: String(scene.shot_type || spec.shot_type || 'Medium Shot'),
        camera_angle: String(scene.camera_angle || 'Eye-level'),
        shot_intent: spec.shot_intent,
        location: String(spec.location),
        primary_action: String(spec.primary_action),
        primary_subject: spec.primary_subject,
        visible_subjects: Array.isArray(spec.visible_subjects) ? spec.visible_subjects : [],
        key_props: Array.isArray(spec.key_props) ? spec.key_props : [],
        subject_scale: spec.subject_scale,
        uniqueness_key: spec.uniqueness_key,
        must_not: Array.isArray(spec.must_not) ? spec.must_not : [],
      };
    });
    pack = prepareCompiledScenes(scenes, contracts as any, chapterContent, characterLocks);
    if (pack.gateError) throw new Error(pack.gateError);
  } else {
    const bannedKeys = scenes
      .map((scene: any) => parseShotSpec(scene.shot_spec)?.uniqueness_key)
      .filter(Boolean);
    const basePrompt = buildSceneVisualPromptRewritePrompt(
      chapter,
      scenes,
      characters,
      bannedKeys
    );
    let generated = await LLMService.generateStructuredLocallyWithRetry(
      basePrompt,
      SceneContractRewriteSchema,
      { maxRetries: 2, temperature: 0.25, maxTokens: 7000 }
    );
    if (!generated) throw new Error('Local model failed to regenerate shot contracts');

    pack = prepareCompiledScenes(scenes, generated.scenes, chapterContent, characterLocks);
    if (pack.gateError) {
      const prevKeys = pack.prepared.map((row) => row.uniqueness_key).filter(Boolean) as string[];
      const hint = `${buildSceneVisualPromptRewritePrompt(chapter, scenes, characters, [
        ...bannedKeys,
        ...prevKeys,
      ])}

CRITICAL RETRY: ${pack.gateError}
Fill DISTINCT contracts; do not copy neighbors.`;
      generated = await LLMService.generateStructuredLocallyWithRetry(
        hint,
        SceneContractRewriteSchema,
        { maxRetries: 1, temperature: 0.35, maxTokens: 7000 }
      );
      if (!generated) throw new Error(`Local model failed gate retry (${pack.gateError})`);
      pack = prepareCompiledScenes(scenes, generated.scenes, chapterContent, characterLocks);
      if (pack.gateError) throw new Error(pack.gateError);
    }
  }

  const { prepared } = pack;

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const row of prepared) {
      // Scenes with existing assets get a new scene_version instead of silent overwrite.
      if (row.has_asset) {
        await createSceneVersion(row.scene_id, {
          activate: true,
          clearAsset: false,
          label: 'prompt-recompile',
        });
      }
      await db.run(
        `UPDATE scene
         SET visual_prompt = ?, negative_prompt = ?, shot_type = ?, camera_angle = ?, shot_spec = ?
         WHERE id = ?`,
        row.visual_prompt,
        row.negative_prompt,
        row.shot_type,
        row.camera_angle,
        row.shot_spec,
        row.scene_id
      );
      await syncActiveVersionFromScene(row.scene_id);
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  return {
    chapter_id: chapterId,
    generated_count: scenes.length,
    scenes: await db.all(
      `SELECT id, "index", visual_prompt, negative_prompt, shot_type, camera_angle, shot_spec
       FROM scene WHERE chapter_id = ? ORDER BY "index" ASC`,
      chapterId
    ),
  };
};
