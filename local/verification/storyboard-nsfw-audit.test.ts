import '../../backend/src/test_setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { db } from '../../backend/src/db/database';
import { SettingsManager } from '../../backend/src/core/settings_manager';
import { ScriptService } from '../../backend/src/services/script_service';
import { createEmptyScriptDocument } from '../../backend/src/schemas/script';
import { StoryboardGenerationService, RawStoryboardShotSchema } from '../../backend/src/services/ai/storyboard_generation_service';
import { compilePonyPrompt } from '../../backend/src/services/pony_prompt_compiler';
import { sanitizeVisualPrompt } from '../../backend/src/services/visual_prompt_sanitizer';
import { buildTimelineVisualPromptPolicy } from '../../backend/src/services/image_generation_policy';
import { resolveEffectiveNsfw, type ProjectNsfwMode } from '../../backend/src/services/project_settings';
import type { AIProvider } from '../../backend/src/services/ai/base';

// Historical audit of ae1eed0, not acceptance tests for the repaired implementation.
// It intentionally fails after the fix; use backend regression tests for acceptance.
// All database writes stay in :memory:; the provider returns a fixed benign contract.
const visibleAction = '成年角色穿着蓝色长袍，摘下手套并拥抱同伴';
const rawShots = [
  { script_scene_id: 'sc_audit', block_ids: ['b_audit_1'], shot_intent: 'establish', shot_type: 'Wide Shot', location: '庭院', primary_action: visibleAction, primary_subject: '林', visible_subjects: ['林'], subject_scale: 'small-15-20' },
  { script_scene_id: 'sc_audit', block_ids: ['b_audit_2'], shot_intent: 'wide-action', shot_type: 'Wide Shot', location: '庭院', primary_action: '林沿石阶走向大门', primary_subject: '林', visible_subjects: ['林'], subject_scale: 'medium-20-40' },
  { script_scene_id: 'sc_audit', block_ids: ['b_audit_3'], shot_intent: 'payoff', shot_type: 'Medium Shot', location: '庭院', primary_action: '林推开木门，灯笼亮起', primary_subject: '林', visible_subjects: ['林'], subject_scale: 'medium-20-40' },
];

test('2026-10-06 audit: reproduce the storyboard mode gap and distinguish compiler behavior', async (t) => {
  let systemNsfwEnabled = false;
  t.mock.method(SettingsManager, 'loadSettings', () => ({
    llm: { model: 'audit-mock' },
    advanced: { nsfw_enabled: systemNsfwEnabled },
  }));
  const project = await db.run('INSERT INTO project(title, settings) VALUES(?, ?)', '分镜开关核查', '{}');
  const projectId = Number(project.lastID);
  const character = await db.run('INSERT INTO character(project_id, name, role, visual_tags) VALUES(?, ?, ?, ?)', projectId, '林', '成年主角', JSON.stringify({ core: 'adult woman, black hair, blue robe' }));
  const characterId = Number(character.lastID);
  const chapterId = 'storyboard_nsfw_audit';
  await db.run('INSERT INTO chapter(id, project_id, title, content, "index") VALUES(?, ?, ?, ?, ?)', chapterId, projectId, '开关对照', visibleAction, 1);
  const script = await ScriptService.createOrGetScript(chapterId, '开关对照');
  const document = createEmptyScriptDocument('开关对照');
  document.locations = [{ id: 'loc_audit', name: '庭院', description: '石阶与木门' }];
  document.scenes = [{
    id: 'sc_audit', beatIds: [], eventIds: [], sourceParagraphIds: [], locationId: 'loc_audit',
    interiorExterior: 'exterior', timeOfDay: 'dusk', characterIds: [characterId], propIds: [],
    blocks: rawShots.map((shot, index) => ({ id: `b_audit_${index + 1}`, type: 'action' as const, text: shot.primary_action })),
  }];
  await ScriptService.saveManualScript({ scriptId: script.id, document, expectedRevision: 1 });
  const confirmed = await ScriptService.confirmScript({ scriptId: script.id, expectedRevision: 2 });

  const prompts: string[] = [];
  const payloads: any[] = [];
  const provider: AIProvider = {
    async generateStructured(prompt, schema) {
      prompts.push(prompt);
      return schema.parse({ shots: rawShots });
    },
    async generateText() { throw new Error('No real model calls permitted in this audit'); },
    async generateImage() { throw new Error('No image generation permitted in this audit'); },
  };
  const modes: Array<{ projectMode: ProjectNsfwMode; system: boolean; expectedEffective: boolean }> = [
    { projectMode: 'on', system: false, expectedEffective: true },
    { projectMode: 'off', system: false, expectedEffective: false },
    { projectMode: 'inherit', system: false, expectedEffective: false },
    { projectMode: 'on', system: true, expectedEffective: true },
    { projectMode: 'off', system: true, expectedEffective: false },
    { projectMode: 'inherit', system: true, expectedEffective: true },
  ];
  for (const [index, mode] of modes.entries()) {
    systemNsfwEnabled = mode.system;
    const settings = { image_generation: { nsfw_mode: mode.projectMode } };
    await db.run('UPDATE project SET settings=? WHERE id=?', JSON.stringify(settings), projectId);
    const candidate = await StoryboardGenerationService.generateStoryboardCandidate({
      scriptId: script.id, expectedRevision: confirmed.revision, requestKey: `audit-${index}`, provider,
    });
    payloads.push(JSON.parse(candidate.after_json));
  }

  await t.test('six effective mode combinations produce identical provider prompts and compiled shots', () => {
    assert.equal(prompts.length, 6);
    assert.equal(new Set(prompts).size, 1);
    assert.equal(new Set(payloads.map(payload => JSON.stringify(payload.shots))).size, 1);
    for (const prompt of prompts) assert.doesNotMatch(prompt, /Shot Contract Policy|NSFW mode ENABLED|SFW \/ family-safe/);
  });
  await t.test('the shared resolver and timeline policy do distinguish the mode combinations', () => {
    for (const mode of modes) {
      assert.equal(resolveEffectiveNsfw({ systemNsfwEnabled: mode.system, projectSettings: { image_generation: { nsfw_mode: mode.projectMode } } as any }), mode.expectedEffective);
    }
    assert.notEqual(buildTimelineVisualPromptPolicy(true), buildTimelineVisualPromptPolicy(false));
  });
  await t.test('the raw model response has no visual_prompt field', () => {
    assert.equal(Object.hasOwn(RawStoryboardShotSchema.shape, 'visual_prompt'), false);
    const parsed = RawStoryboardShotSchema.parse({ ...rawShots[0], visual_prompt: 'ignored freeform prompt' });
    assert.equal(Object.hasOwn(parsed, 'visual_prompt'), false);
  });
  await t.test('visible actions and clothing survive contract compilation, sanitization and candidate storage', () => {
    for (const intent of ['establish', 'wide-action', 'medium-action']) {
      const compiled = compilePonyPrompt({ ...rawShots[0]!, shot_intent: intent }, [{ name: '林', lock: 'adult woman, black hair, blue robe' }]);
      assert.ok(compiled.visual_prompt.includes(visibleAction));
      assert.ok(sanitizeVisualPrompt(compiled.visual_prompt).visual_prompt.includes(visibleAction));
      assert.match(compiled.visual_prompt, /black hair/);
    }
    for (const payload of payloads) {
      assert.equal(JSON.parse(payload.shots[0].shot_spec).primary_action, visibleAction);
      assert.ok(payload.shots[0].visual_prompt.includes(visibleAction));
    }
  });

  assert.equal(new Set(prompts).size, 1, 'Historical baseline changed; do not overwrite the saved audit evidence');
  fs.writeFileSync(path.join(process.cwd(), 'local/verification/storyboard-nsfw-audit.json'), JSON.stringify({
    verifiedDate: '2026-10-06', baseline: 'ae1eed0', database: ':memory:', provider: 'mock',
    uniqueProviderPrompts: new Set(prompts).size,
    modeMatrix: modes.map((mode, index) => ({ ...mode, promptSha256: crypto.createHash('sha256').update(prompts[index]!).digest('hex') })),
    findings: { storyboardModeNotWired: true, rawVisualPromptField: false, visiblePrimaryActionPreserved: true },
    productionModelCalls: 0,
  }, null, 2) + '\n', 'utf8');
});
