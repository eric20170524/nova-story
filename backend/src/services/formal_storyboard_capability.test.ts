import '../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import samplesFile from '../test_fixtures/formal_storyboard/samples-v1.json';
import {
  FORMAL_BASELINE_FAILURES,
  FORMAL_FS02_RESOLVED,
  FORMAL_REJECTED_3060_WORKFLOW,
  FORMAL_SDXL_3060_WORKFLOW,
  assertIsolatedFormalDatabase,
  assessFormalInstall,
  assessFormalShot,
  classifyFormalModel,
  formalSampleShotSpec,
  formalTemplateDecision,
  inspectFormalWiring,
  type FormalShotSample,
} from './formal_storyboard_capability';

const samples = samplesFile.samples as FormalShotSample[];
const sample = (id: string) => samples.find((row) => row.id === id)!;

const fullNodes = () => Object.fromEntries([
  'LoadImage', 'IPAdapterModelLoader', 'CLIPVisionLoader', 'IPAdapterAdvanced',
  'ControlNetLoader', 'ControlNetApplyAdvanced', 'OpenposePreprocessor',
  'DepthAnythingPreprocessor', 'CannyEdgePreprocessor',
].map((name) => [name, {}]));

const makeInstall = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-formal-'));
  fs.mkdirSync(path.join(root, 'models', 'ipadapter'), { recursive: true });
  fs.mkdirSync(path.join(root, 'models', 'clip_vision'), { recursive: true });
  fs.mkdirSync(path.join(root, 'models', 'controlnet'), { recursive: true });
  fs.mkdirSync(path.join(root, 'custom_nodes', 'ComfyUI_IPAdapter_plus'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models', 'ipadapter', 'ip-adapter-plus_sdxl_vit-h.safetensors'), 'ipa');
  fs.writeFileSync(path.join(root, 'models', 'clip_vision', 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors'), 'clip');
  fs.writeFileSync(path.join(root, 'models', 'controlnet', 'controlnet-openpose-sdxl.safetensors'), 'pose');
  return root;
};

const connectedIdentity = () => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'pony.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'b' } },
  '4': { class_type: 'LoadImage', inputs: { image: 'face.png' } },
  '5': { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: 'ip-adapter-plus_sdxl_vit-h.safetensors' } },
  '6': { class_type: 'CLIPVisionLoader', inputs: { clip_name: 'CLIP-ViT-H-14.safetensors' } },
  '7': {
    class_type: 'IPAdapterAdvanced',
    inputs: { model: ['1', 0], ipadapter: ['5', 0], image: ['4', 0], clip_vision: ['6', 0], weight: 0.6 },
  },
  '8': { class_type: 'KSampler', inputs: { model: ['7', 0], positive: ['2', 0], negative: ['3', 0] } },
});

const baseInput = (shot: FormalShotSample, installPath: string) => ({
  modelName: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
  workflowFile: FORMAL_SDXL_3060_WORKFLOW,
  installPath,
  runtime: 'online' as const,
  objectInfo: fullNodes(),
  shot,
  hashFiles: true,
});

test('formal model classes keep SDXL checkpoints together and Krea2 apart', () => {
  assert.equal(classifyFormalModel('ponyDiffusionV6XL').model_class, 'sdxl');
  assert.equal(classifyFormalModel('autismmixSDXL_autismmixPony').model_class, 'sdxl');
  assert.equal(classifyFormalModel('Juggernaut-XL-v9').model_class, 'sdxl');
  assert.equal(classifyFormalModel('krea2_turbo_int8_convrot').label, 'Krea2 INT8 ConvRot');
  assert.equal(classifyFormalModel('anything-v5').model_class, 'sd15');
  assert.equal(formalTemplateDecision(FORMAL_SDXL_3060_WORKFLOW).role, 'sdxl_3060');
  assert.equal(formalTemplateDecision(FORMAL_REJECTED_3060_WORKFLOW).accepted, false);
});

test('frozen samples keep 9995, 9996, and the same-scene camera pair', () => {
  assert.equal(sample('fs-9995').kind, 'single_wide_action');
  assert.equal(sample('fs-9995').visible_subjects.length, 1);
  assert.equal(sample('fs-9995').has_continuity, false);
  assert.equal(sample('fs-9996').visible_subjects.length, 3);
  assert.equal(sample('fs-9996').script_scene_id, 'sc_2');
  assert.equal(sample('fs-camera-wide').script_scene_id, sample('fs-camera-close').script_scene_id);
  assert.notEqual(sample('fs-camera-wide').shot_type, sample('fs-camera-close').shot_type);
  assert.equal(sample('fs-empty').visible_subjects.length, 0);
  assert.deepEqual(FORMAL_FS02_RESOLVED, [
    'draft-continuity-gate',
    'queue-clears-asset-url',
    'success-writes-shot-master',
  ]);
  assert.deepEqual(FORMAL_BASELINE_FAILURES.map((row) => row.id), ['client-first-character']);
});

test('formal samples insert only into an isolated database', async () => {
  assert.throws(() => assertIsolatedFormalDatabase('D:/data/sql_app.db'), /production database/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-formal-db-')), 'formal-samples.sqlite');
  assertIsolatedFormalDatabase(file);
  const db = await open({ filename: file, driver: sqlite3.Database });
  try {
    await db.exec('CREATE TABLE scene (id INTEGER PRIMARY KEY, shot_spec TEXT, continuity_status TEXT)');
    for (const row of samples) {
      await db.run(
        'INSERT INTO scene (id, shot_spec, continuity_status) VALUES (?, ?, ?)',
        row.production_scene_id ?? samples.indexOf(row) + 1,
        JSON.stringify(formalSampleShotSpec(row)),
        row.continuity_status
      );
    }
    const stored = await db.get('SELECT shot_spec FROM scene WHERE id = 9995');
    assert.equal(JSON.parse(stored.shot_spec).visible_subjects[0], '南宫雪');
    assert.equal(await db.get("SELECT 1 AS ok FROM sqlite_master WHERE name = 'scene_production_frame'"), undefined);
  } finally {
    await db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('capability states do not treat a directory or one node as a loaded chain', () => {
  const root = makeInstall();
  try {
    const offline = assessFormalShot({
      ...baseInput(sample('fs-closeup'), root),
      runtime: 'offline',
      objectInfo: null,
    }).find((row) => row.id === 'sdxl_ip_adapter')!;
    assert.equal(offline.installed, true);
    assert.equal(offline.nodes_loaded, false);
    assert.equal(offline.reason, 'offline');
    assert.match(offline.weights[0]!.sha256 || '', /^[a-f0-9]{64}$/);

    const oneNode = assessFormalShot({
      ...baseInput(sample('fs-closeup'), root),
      objectInfo: { IPAdapter: {}, LoadImage: {} },
    }).find((row) => row.id === 'sdxl_ip_adapter')!;
    assert.equal(oneNode.nodes_loaded, false);
    assert.equal(oneNode.reason, 'not_installed');

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-formal-empty-'));
    fs.mkdirSync(path.join(empty, 'custom_nodes', 'ComfyUI_IPAdapter_plus'), { recursive: true });
    const directoryOnly = assessFormalShot({
      ...baseInput(sample('fs-closeup'), empty),
      objectInfo: fullNodes(),
    }).find((row) => row.id === 'sdxl_ip_adapter')!;
    assert.equal(directoryOnly.installed, false);
    assert.equal(directoryOnly.reason, 'not_installed');
    fs.rmSync(empty, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frozen shots report policy, missing reference, family, and template separately', () => {
  const root = makeInstall();
  try {
    const byId = (shot: FormalShotSample, extra: Record<string, unknown> = {}) =>
      assessFormalShot({ ...baseInput(shot, root), ...extra });
    const identity = (rows: ReturnType<typeof assessFormalShot>) => rows.find((row) => row.id === 'sdxl_ip_adapter')!;

    const wide = identity(byId(sample('fs-9995')));
    assert.equal(wide.shot_allowed, false);
    assert.equal(wide.policy_reason, 'scene_prefers_txt2img');
    assert.equal(wide.reason, 'policy_skipped');
    assert.equal(wide.live_verified, false);

    const three = identity(byId(sample('fs-9996')));
    assert.equal(three.policy_reason, 'multi_person_story');
    assert.equal(three.reason, 'policy_skipped');

    const empty = byId(sample('fs-empty'));
    assert.equal(identity(empty).policy_reason, 'empty_plate');
    assert.equal(empty.find((row) => row.id === 'sdxl_openpose')!.policy_reason, 'no_person');
    assert.equal(empty.find((row) => row.id === 'sdxl_openpose')!.reason, 'policy_skipped');

    const close = identity(byId(sample('fs-closeup')));
    assert.equal(close.shot_allowed, true);
    assert.equal(close.reason, 'missing_reference');
    assert.equal(close.wired, false);

    const compiled = identity(byId(
      { ...sample('fs-closeup'), character_ref_url: '/static/face.png' },
      { workflow: connectedIdentity() }
    ));
    assert.equal(compiled.chain_ready, true);
    assert.equal(compiled.live_verified, false);
    assert.equal(compiled.reason, null);

    const krea = identity(byId(sample('fs-closeup'), { modelName: 'krea2_turbo_int8_convrot.safetensors' }));
    assert.equal(krea.family_match, false);
    assert.equal(krea.reason, 'incompatible');
    const kreaNative = byId(sample('fs-closeup'), {
      modelName: 'krea2_turbo_int8_convrot.safetensors',
      workflowFile: 'redcraft_krea2_12gb.json',
    }).find((row) => row.id === 'krea2_native_reference')!;
    assert.equal(kreaNative.family_match, true);
    assert.equal(kreaNative.installed, false);
    assert.equal(kreaNative.nodes_loaded, false);
    assert.equal(kreaNative.reason, 'not_installed');

    const l40 = identity(byId(sample('fs-closeup'), {
      workflowFile: FORMAL_REJECTED_3060_WORKFLOW,
      workflow: connectedIdentity(),
    }));
    assert.equal(l40.wired, false);
    assert.equal(l40.reason, 'incompatible');
    assert.equal(inspectFormalWiring({ '1': { class_type: 'IPAdapterModelLoader', inputs: {} } }, null).sdxl_ip_adapter, false);
    const install = assessFormalInstall({
      modelName: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
      workflowFile: FORMAL_SDXL_3060_WORKFLOW,
      installPath: root,
      runtime: 'online',
      objectInfo: fullNodes(),
      workflow: null,
    });
    const installIdentity = install.capabilities.find((row) => row.id === 'sdxl_ip_adapter')!;
    assert.equal(installIdentity.policy_reason, null);
    assert.equal(installIdentity.chain_ready, false);
    assert.equal(installIdentity.reason, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
