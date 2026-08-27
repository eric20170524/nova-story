/**
 * Shared chapter → narrative timeline generation.
 * Used by POST /timeline/generate and Agent OS GENERATE_TIMELINE so both paths
 * share transactions, scene_version baselines, and character profile wiring.
 */
import { db } from '../db/database';
import { LLMService } from './llm';
import { SettingsManager } from '../core/settings_manager';
import { parseProjectSettings, resolveEffectiveNsfw } from './project_settings';
import { formatVisualLockTokens } from './reference_generation_policy';
import {
  annotateSceneWithVersions,
  ensureSceneVersionBaseline,
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
} from './shot_intent_quota';
import { compileNegativePrompt } from './negative_prompt_compiler';
import { packShotSpec } from '../schemas/shot_contract';
import {
  compilePonyPrompt,
  type CharacterLockRef,
} from './pony_prompt_compiler';

const parseCharacterTags = (raw: unknown): any => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
  } catch {
    return {};
  }
};

export async function buildCharacterLockRefsForChapter(
  projectId: number,
  chapterId: string
): Promise<CharacterLockRef[]> {
  const characters = await db.all(
    'SELECT * FROM character WHERE project_id = ?',
    projectId
  );
  if (!characters?.length) return [];
  return characters
    .map((c: any) => {
      const tags = parseCharacterTags(c.visual_tags);
      const lock = formatVisualLockTokens(tags, { chapterId });
      if (!lock || /^\(none/i.test(lock)) return null;
      const aliases = Array.isArray(tags?.aliases)
        ? tags.aliases.map((a: unknown) => String(a || '').trim()).filter(Boolean)
        : [];
      return {
        name: String(c.name || '').trim() || null,
        aliases,
        lock,
      } satisfies CharacterLockRef;
    })
    .filter(Boolean) as CharacterLockRef[];
}

export async function buildCharacterProfilesForChapter(
  projectId: number,
  chapterId: string
): Promise<string> {
  const characters = await db.all(
    'SELECT * FROM character WHERE project_id = ?',
    projectId
  );
  if (!characters?.length) return '';

  const profiles = characters.map((c: any) => {
    const tags = parseCharacterTags(c.visual_tags);
    const lock = formatVisualLockTokens(tags, { chapterId });
    return `- Name: ${c.name}\n  Visual Lock: ${lock || '(none — do not invent appearance tags)'}`;
  });

  return profiles.join('\n');
}

/**
 * Replace chapter scenes with LLM narrative storyboard inside a transaction.
 * Each new scene gets a scene_version baseline (same as timeline route).
 */
export async function generateAndReplaceNarrativeTimeline(options: {
  chapterId: string;
  projectId: number;
  content: string;
  mode?: string;
}): Promise<{ chapter_id: string; storyboard_mode: string; timeline: any[]; count: number }> {
  const mode = (options.mode || 'narrative').toLowerCase();
  if (['cinematic_grid', 'nine_shot_coverage'].includes(mode)) {
    throw new Error(
      "Chapter-level nine_shot_coverage is deprecated. Use per-scene coverage instead."
    );
  }
  if (!['narrative', 'standard'].includes(mode)) {
    throw new Error(
      `Invalid mode '${options.mode}'. Only 'narrative' is supported for auto-storyboard.`
    );
  }
  if (!options.content?.trim()) {
    throw new Error('Chapter has no content');
  }

  const charProfilesStr = await buildCharacterProfilesForChapter(
    options.projectId,
    options.chapterId
  );

  const project = await db.get(
    'SELECT settings FROM project WHERE id = ?',
    options.projectId
  );
  const projectSettings = parseProjectSettings(project?.settings);
  const nsfwEnabled = resolveEffectiveNsfw({
    systemNsfwEnabled: Boolean(
      SettingsManager.loadSettings()?.advanced?.nsfw_enabled
    ),
    projectSettings,
  });

  const timelineData = await LLMService.generateTimeline(
    options.content,
    charProfilesStr,
    'narrative',
    undefined,
    { nsfwEnabled }
  );

  const characterLocks = await buildCharacterLockRefsForChapter(
    options.projectId,
    options.chapterId
  );

  const preparedShots = (timelineData || []).map((item: any) => {
    const location = String(item.location || item.shot_spec?.location || '').trim();
    const primary_action = String(
      item.primary_action || item.shot_spec?.primary_action || ''
    ).trim();
    const key_props = item.key_props || item.shot_spec?.key_props || [];
    const shot_intent = item.shot_intent || item.shot_spec?.shot_intent || null;
    const subject_scale = item.subject_scale || item.shot_spec?.subject_scale || null;
    const primary_subject =
      item.primary_subject || item.shot_spec?.primary_subject || null;
    const visible_subjects =
      item.visible_subjects || item.shot_spec?.visible_subjects || [];

    // Always compile from contract; ignore LLM prose visual_prompt (Phase 2 redline).
    const compiled = compilePonyPrompt(
      {
        shot_intent,
        shot_type: item.shot_type,
        location,
        primary_action,
        primary_subject,
        visible_subjects,
        key_props,
        subject_scale,
        must_not: item.must_not || item.shot_spec?.must_not || [],
      },
      characterLocks
    );
    const sanitized = sanitizeVisualPrompt(compiled.visual_prompt);
    const compiledNegative = compileNegativePrompt({
      shot_type: item.shot_type,
      shot_intent: compiled.shot_intent || shot_intent,
      visual_prompt: sanitized.visual_prompt,
      location,
      key_props,
      character_lock: characterLocks.map((ref) => ref.lock).join(', '),
      identity_mode: 'auto',
    });
    const negative = [
      compiledNegative,
      item.negative_prompt,
      ...compiled.negative_extras,
      ...sanitized.negative_extras,
    ]
      .filter(Boolean)
      .join(', ');
    const uniqueness_key =
      item.uniqueness_key || item.shot_spec?.uniqueness_key || null;
    const shot_spec = packShotSpec({
      shot_intent,
      location,
      primary_action,
      primary_subject,
      visible_subjects,
      key_props,
      subject_scale,
      uniqueness_key,
      must_not: item.must_not || item.shot_spec?.must_not || [],
      shot_type: item.shot_type,
    });
    return {
      ...item,
      location,
      primary_action,
      key_props,
      shot_intent,
      subject_scale,
      primary_subject,
      visible_subjects,
      visual_prompt: sanitized.visual_prompt,
      negative_prompt: negative || null,
      uniqueness_key,
      shot_spec,
    };
  });
  const uniqueness = assertChapterUniqueness(
    preparedShots.map((shot: any) => ({
      visual_prompt: shot.visual_prompt,
      uniqueness_key: shot.uniqueness_key,
    }))
  );
  if (uniqueness.ok === false) {
    throw new Error(formatUniquenessFailure(uniqueness.violation));
  }

  const quota = assertChapterShotQuota(
    preparedShots.map((shot: any) => ({
      shot_type: shot.shot_type,
      shot_intent: shot.shot_intent || shot.shot_spec?.shot_intent,
      visual_prompt: shot.visual_prompt,
    })),
    { hasKeyProps: chapterLikelyHasKeyProps(options.content) }
  );
  if (quota.ok === false) {
    throw new Error(formatShotQuotaFailure(quota.violation));
  }

  if (!timelineData || timelineData.length === 0) {
    throw new Error('LLM returned empty timeline data');
  }

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Clean coverage trees for existing scenes (legacy DBs may lack CASCADE)
    await db.run(
      `DELETE FROM coverage_shot
       WHERE coverage_group_id IN (
         SELECT coverage_group.id
         FROM coverage_group
         INNER JOIN scene ON scene.id = coverage_group.source_scene_id
         WHERE scene.chapter_id = ?
       )`,
      options.chapterId
    );
    await db.run(
      `DELETE FROM coverage_group
       WHERE source_scene_id IN (
         SELECT id FROM scene WHERE chapter_id = ?
       )`,
      options.chapterId
    );
    await db.run('DELETE FROM scene WHERE chapter_id = ?', options.chapterId);

    const newScenes: any[] = [];
    for (let i = 0; i < preparedShots.length; i++) {
      const item = preparedShots[i];
      const result = await db.run(
        `INSERT INTO scene (
           chapter_id, "index", visual_prompt, audio_prompt, dialogue, narration, duration,
           shot_type, camera_movement, camera_angle, negative_prompt, shot_spec, asset_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
        options.chapterId,
        i + 1,
        item.visual_prompt || '',
        item.audio_prompt || '',
        item.dialogue || '',
        item.narration || '',
        item.duration || 3.0,
        item.shot_type || '',
        item.camera_movement || '',
        item.camera_angle || '',
        item.negative_prompt || null,
        item.shot_spec || null
      );

      const newScene = await db.get(
        'SELECT * FROM scene WHERE id = ?',
        result.lastID
      );
      if (newScene) {
        await ensureSceneVersionBaseline(newScene.id);
        newScenes.push(await annotateSceneWithVersions(newScene));
      }
    }

    await db.exec('COMMIT');

    return {
      chapter_id: options.chapterId,
      storyboard_mode: 'narrative',
      timeline: newScenes,
      count: newScenes.length,
    };
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
