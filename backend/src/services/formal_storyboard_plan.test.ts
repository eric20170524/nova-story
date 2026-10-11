import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { injectTierBAdapters, type TierBCapability } from './tier_b_adapters';
import { shouldAllowCharacterAdapter } from './reference_generation_policy';
import {
  FORMAL_OPEN_COMBINATIONS,
  appearanceConflict,
  assembleFormalReferences,
  formalRenderAllowed,
  krea2ReferenceBoundary,
  markFormalStale,
  masksConflict,
  planFormalBatch,
  readFormalPin,
  resolveVisibleCharacters,
  selectFormalVideoStill,
  selectPreviousFrame,
  suggestSceneBoard,
  validateMask,
} from './formal_storyboard_plan';

const pony = () => ({
  '3': { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['6', 0], negative: ['7', 0], denoise: 1 } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'b' } },
});

test('formal assembly resolves each person, keeps version 1 pins, and ignores client reference overrides', () => {
  const pin = readFormalPin(JSON.stringify({ version: 1, references: [{ entity_id: 'a' }] }), {
    entries: [{ entity_id: 'character:1', role: 'face', version: 2, content_hash: 'h', image_url: '/face.png' }],
  });
  assert.equal(pin.version1?.version, 1);
  assert.equal(pin.version2?.entries[0]?.role, 'face');
  const names = resolveVisibleCharacters(['南宫雪', '南宫雪'], [
    { id: 1, name: '南宫雪', project_id: 2 },
    { id: 9, name: '南宫雪', project_id: 8 },
  ], 2);
  assert.equal(names.resolved.length, 2);
  assert.equal(names.errors.length, 0);
  const ambiguous = resolveVisibleCharacters(['南宫雪'], [
    { id: 1, name: '南宫雪', project_id: 2 },
    { id: 2, name: '南宫雪', project_id: 2 },
  ], 2);
  assert.equal(ambiguous.errors[0]?.code, 'ambiguous');
  const assembled = assembleFormalReferences({
    projectId: 2,
    visibleNames: ['南宫雪', '裴雨涵'],
    locationName: '清暮宫内殿',
    sceneBoards: [{ id: 4, name: '清暮宫内殿', project_id: 2 }],
    characters: [
      { id: 1, name: '南宫雪', project_id: 2, lora: 'xue.safetensors', visual_tags: JSON.stringify({ assets: { face_url: '/xue-face.png', turnaround_url: '/xue-body.png' } }) },
      { id: 3, name: '裴雨涵', project_id: 2, lora: 'pei.safetensors', visual_tags: JSON.stringify({ assets: { face_url: '/pei-face.png' } }) },
    ],
    clientWorkflow: { character_ref_url: '/client.png', force_character_adapter: true },
    loraSlots: 1,
  });
  assert.equal(assembled.ok, true);
  if (!assembled.ok) return;
  assert.deepEqual(assembled.ignored, ['character_ref_url', 'force_character_adapter']);
  assert.equal(assembled.entries.filter((entry) => entry.character_id === 1).map((entry) => entry.role).join(','), 'face,body');
  assert.equal(assembled.suggestion?.confirmed, false);
  assert.deepEqual(assembled.unused, ['multiple_character_loras_not_supported']);
  assert.equal(appearanceConflict('{"hair":"black"}', 'white hair'), true);
  const conflict = assembleFormalReferences({
    visibleNames: ['南宫雪'],
    characters: [{ id: 1, name: '南宫雪', visual_tags: 'black hair', identity_lock: 'white hair' }],
  });
  assert.equal(conflict.ok, false);
  assert.equal(suggestSceneBoard('清暮宫内殿', [{ id: 4, name: '清暮宫内殿' }])?.confirmed, false);
});

test('formal controls stay closed until a live combination is recorded', () => {
  assert.deepEqual(FORMAL_OPEN_COMBINATIONS, []);
  assert.equal(formalRenderAllowed('sdxl_ip_adapter'), false);
  const workflow = pony();
  const capability = {
    characterAdapter: true, compositionControl: false, modelFamilySupported: true, characterKind: 'ip_adapter', compositionKind: 'none',
    models: { ipadapter: 'ip-adapter-plus_sdxl_vit-h.safetensors', clipVision: 'CLIP-ViT-H-14.safetensors', controlnet: null, compositionKind: 'none' },
    hasIpAdapterNodes: true, hasControlNetNodes: true, hasOpenPosePreprocessor: false, missing: [], notes: [],
  } as TierBCapability;
  const wired = injectTierBAdapters(workflow, {
    characterImageFilename: 'face.png', capability, isFlux: false,
  });
  assert.equal(wired.characterWired, true);
  assert.equal(workflow['3'].inputs.model[0] !== '4', true);
  const draft = shouldAllowCharacterAdapter({ gen_type: 'scene', shot_type: 'Wide Shot', shot_spec: { visible_subjects: ['南宫雪'], shot_type: 'Wide Shot' } }, '');
  assert.equal(draft.allow, false);
  assert.equal(draft.reason, 'scene_prefers_txt2img');
});

test('masks, previous frame, batch, stale marks and video stills follow the formal contract', () => {
  const mask = { entity_id: 'character:1', character_id: 1, role: 'identity_region' as const, version: 1, content_hash: 'm', mask: { x: 0, y: 0, width: 100, height: 100 } };
  assert.equal(validateMask({ ...mask, mask: { x: 1200, y: 0, width: 200, height: 10 } }).ok, false);
  assert.equal(masksConflict([mask, { ...mask, character_id: 2, mask: { x: 50, y: 50, width: 80, height: 80 } }]), true);
  const previous = selectPreviousFrame({
    scriptSceneId: 'sc_1', momentId: 'sc_1:exit', cameraRelation: 'coverage', storyOrder: 2,
    candidates: [{ id: 1, script_scene_id: 'sc_1', moment_id: 'sc_1:exit', story_order: 1, index: 9, asset_url: '/a.png', version: 1 }],
  });
  assert.equal(previous.ok, false);
  const continuation = selectPreviousFrame({
    scriptSceneId: 'sc_1', momentId: 'sc_1:exit', cameraRelation: 'continuation', storyOrder: 2,
    candidates: [
      { id: 1, script_scene_id: 'sc_1', moment_id: 'sc_1:exit', story_order: 1, index: 1, asset_url: '/a.png', version: 3 },
      { id: 8, script_scene_id: 'sc_2', moment_id: 'sc_2:exit', story_order: 1, index: 0, asset_url: '/other.png', version: 1 },
    ],
  });
  assert.equal(continuation.ok && continuation.source_id, 1);
  const batch = planFormalBatch([
    { id: 1, selected: true, missing: 'offline' },
    { id: 2, selected: true, hasFormal: true },
    { id: 3, selected: false, failed: true },
  ]);
  assert.deepEqual(batch.eligible, []);
  assert.equal(batch.counts.failed, 1);
  const stale = markFormalStale([{ version: 2, asset_url: '/kept.png', entity_ids: ['character:1'], review: 'accepted' }], ['character:1']);
  assert.equal(stale[0]?.stale, true);
  assert.equal(stale[0]?.asset_url, '/kept.png');
  const video = selectFormalVideoStill({ activeUrl: '/draft.png', candidateUrl: '/candidate.png', review: null });
  assert.equal(video.url, '/draft.png');
  assert.equal(video.purpose, 'draft');
  const adopted = selectFormalVideoStill({ activeUrl: '/formal.png', review: 'accepted', stale: false });
  assert.equal(adopted.purpose, 'formal');
});

test('Krea2 reference boundary stays closed and separate from SDXL adapters', () => {
  const workflow = JSON.parse(fs.readFileSync(path.resolve('static/workflows/redcraft_krea2_12gb.json'), 'utf8'));
  const types = Object.values(workflow).map((node: any) => String(node.class_type));
  const boundary = krea2ReferenceBoundary(types);
  assert.equal(boundary.interface_present, false);
  assert.equal(boundary.identity_locked, false);
  assert.equal(boundary.formal_open, false);
  assert.equal(boundary.sdxl_adapters_injected, false);
  assert.equal(boundary.img2img_separate_from_reference, true);
});
