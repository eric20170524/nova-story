import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  inferComfyWorkflowFamily,
  selectComfyWorkflow,
  type ComfyWorkflowRow,
  type ComfyWorkflowLookup
} from './comfy_workflow_selection';

const workflow = (id: number, name: string, checkpoint: string): ComfyWorkflowRow => ({
  id,
  name,
  content: JSON.stringify({
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } }
  })
});

const rows = [
  workflow(3, 'pony_xl_12gb', 'ponyDiffusionV6XL.safetensors'),
  workflow(4, 'sd15_draft_12gb', 'sd15.safetensors'),
  workflow(7, 'autismmix_pony_l40', 'autismmixSDXL_autismmixPony.safetensors')
];
const lookup: ComfyWorkflowLookup = {
  byId: async (id) => rows.find((row) => row.id === id) || null,
  byName: async (name) => rows.find((row) => row.name === name) || null
};
const image = (model: 'pony' | 'sd15' | 'redcraft_krea2' | 'qwen_image', workflow_id: number | null = null) => ({
  image_generation: { model, workflow_id, style: 'xianxia_immortal',
    output_spec: { aspect_ratio: '16:9', resolution: 'standard', orientation_policy: 'fixed' },
    nsfw_mode: 'inherit' }
});

test('project workflow wins over a generic explicit Pony model', async () => {
  const selected = await selectComfyWorkflow(
    { project_settings: image('pony', 7) },
    { comfyui: {} },
    lookup
  );
  assert.equal(selected.row.id, 7);
  assert.equal(selected.source, 'project');
});

test('request workflow ID cannot override the project workflow', async () => {
  const selected = await selectComfyWorkflow(
    { workflow_id: 3, model_type: 'sd15', project_settings: image('pony', 7) },
    { comfyui: {} },
    lookup
  );
  assert.equal(selected.row.id, 7);
  assert.equal(selected.source, 'project');
});

test('incompatible project workflow fails visibly', async () => {
  await assert.rejects(selectComfyWorkflow(
    { project_settings: image('sd15', 7) }, { comfyui: {} }, lookup
  ), /project model is sd15/);
});

test('missing project workflow fails instead of silently selecting another model', async () => {
  await assert.rejects(
    selectComfyWorkflow(
      { project_settings: image('pony', 99) },
      { comfyui: {} },
      lookup
    ),
    /workflow ID 99 was not found/
  );
});

test('missing model family never falls back to an incompatible Pony workflow', async () => {
  const ponyOnly: ComfyWorkflowLookup = {
    byId: lookup.byId,
    byName: async (name) => name === 'pony_xl_12gb' ? rows[0]! : null
  };
  await assert.rejects(
    selectComfyWorkflow({ project_settings: image('sd15') }, { comfyui: {} }, ponyOnly),
    /No ComfyUI workflow is configured for model 'sd15'/
  );
});

test('qwen-image 2.1 graph is its own family and is the automatic match', async () => {
  const content = fs.readFileSync(path.resolve('static/workflows/qwen_image_2_1.json'), 'utf8');
  const graph = JSON.parse(content);
  assert.equal(graph['4'].inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors');
  assert.equal(graph['6'].class_type, 'TextEncodeQwenImage21');
  assert.equal(graph['10'].inputs.type, 'qwen_image');
  assert.equal(inferComfyWorkflowFamily({ id: 11, name: 'qwen_image_2_1', content }), 'qwen_image');
  const krea = fs.readFileSync(path.resolve('static/workflows/redcraft_krea2_12gb.json'), 'utf8');
  assert.equal(inferComfyWorkflowFamily({ id: 8, name: 'redcraft_krea2_12gb', content: krea }), 'redcraft_krea2');

  const qwenRow = { id: 11, name: 'qwen_image_2_1', content };
  const withQwen: ComfyWorkflowLookup = {
    byId: async (id) => id === 11 ? qwenRow : lookup.byId(id),
    byName: async (name) => name === 'qwen_image_2_1' ? qwenRow : lookup.byName(name)
  };
  const selected = await selectComfyWorkflow(
    { project_settings: image('qwen_image') },
    { comfyui: { selected_workflow_file: 'autismmix_pony_l40.json' } },
    withQwen
  );
  assert.equal(selected.row.name, 'qwen_image_2_1');
  assert.equal(selected.family, 'qwen_image');
  assert.equal(selected.source, 'model');
  await assert.rejects(
    selectComfyWorkflow({ project_settings: image('qwen_image', 7) }, { comfyui: {} }, withQwen),
    /uses pony/
  );
});

test('system selection does not override the project model', async () => {
  const selected = await selectComfyWorkflow(
    { project_settings: image('pony') },
    { comfyui: { selected_workflow_file: 'autismmix_pony_l40.json' } },
    lookup
  );
  assert.equal(selected.row.id, 3);
  assert.equal(selected.source, 'model');
});
