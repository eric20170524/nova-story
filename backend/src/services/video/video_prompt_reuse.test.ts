import '../../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { db, initDb } from '../../db/database';
import { VideoGenerationRequestSchema } from '../../schemas/video';
import { VideoGenerationService } from './video_generation_service';
import { VideoSpecCompiler, setVideoMotionTranslatorForTests } from './video_spec_compiler';
import { MediaAssetService } from './media_asset_service';
import { GpuLeaseService } from '../gpu_lease_service';
import { ComfyH3Provider } from './comfy_h3_provider';
import { VideoWorkflowCompiler } from './video_workflow_compiler';

test('video preflight, submission and execution reuse one motion paragraph and reject changed sources before GPU handoff', async t => {
  await initDb();
  const oldFlag = process.env.NOVASTORY_ENABLE_VIDEO;
  process.env.NOVASTORY_ENABLE_VIDEO = 'true';
  GpuLeaseService.resetForTesting();
  await db.run("INSERT INTO project(id,title) VALUES(93501,'Prompt reuse')");
  await db.run(`INSERT INTO chapter(id,project_id,"index",title) VALUES('video-reuse',93501,1,'Test')`);
  await db.run(`INSERT INTO scene(id,chapter_id,"index",visual_prompt,shot_spec,camera_angle) VALUES(93511,'video-reuse',1,'A hero holds a cup.',?, 'Eye-level')`, JSON.stringify({ location: 'courtyard', primary_action: 'A hero holds a cup.' }));
  const keyframe = await MediaAssetService.createAsset({ project_id: 93501, scene_id: 93511, scene_version: 1,
    media_type: 'image', role: 'video_keyframe', status: 'ready', url: '/static/generated/reuse-frame.png', width: 1280, height: 720 });
  const service = VideoGenerationService as any;
  const pipeline = service.runTaskPipeline;
  let submitted: any;
  service.runTaskPipeline = async (_id: string, request: any) => { submitted = { ...request }; };
  let calls = 0;
  setVideoMotionTranslatorForTests(async () => `The hero holds a cup, motion version ${++calls}.`);
  try {
    const request = VideoGenerationRequestSchema.parse({ scene_id: 93511, keyframe_asset_id: keyframe.id, request_key: 'reuse-task' });
    const preview = await VideoGenerationService.preflight(request);
    assert.equal(preview.ready, true);
    const again = await VideoGenerationService.preflight({ ...request, expected_input_signature: preview.input_signature });
    assert.equal(again.input_signature, preview.input_signature);
    assert.equal(again.compiled_spec!.positive_prompt, preview.compiled_spec!.positive_prompt);
    const created = await VideoGenerationService.createTask({ ...request, expected_input_signature: preview.input_signature });
    assert.equal(calls, 1);
    const row = await db.get('SELECT metadata_json FROM generation_task WHERE task_id=?', created.task_id);
    assert.deepEqual(JSON.parse(row.metadata_json).compiled_spec, preview.compiled_spec);
    assert.deepEqual(await service.preparedSpec(created.task_id, submitted), preview.compiled_spec);
    assert.equal(calls, 1);
    // A new compiler invocation must be impossible once video model preparation starts.
    t.mock.method(VideoSpecCompiler, 'compile', async () => { throw new Error('unexpected inference during execution'); });
    t.mock.method(GpuLeaseService, 'prepareGpuForTask', async () => { assert.equal(calls, 1); return { ok: true, message: '' }; });
    t.mock.method(MediaAssetService, 'stageAssetForComfy', async () => ({ stagedFilename: 'frame.png' } as any));
    t.mock.method(VideoWorkflowCompiler, 'compile', () => ({ workflow: {}, appliedParams: {} } as any));
    let executed = false;
    t.mock.method(ComfyH3Provider.prototype, 'executeWorkflow', async () => { executed = true; throw new Error('stop after submission for test'); });
    await pipeline.call(service, created.task_id, submitted);
    assert.equal(executed, true);
    assert.equal(calls, 1);
    await db.run("UPDATE scene SET camera_angle='Low-angle' WHERE id=93511");
    await assert.rejects(() => service.preparedSpec(created.task_id, submitted), /inputs changed/);
    assert.equal(calls, 1);
    // Failure before the pipeline's own acquisition must release createTask's reservation.
    await db.run("UPDATE generation_task SET status='processing',stage='queued' WHERE task_id=?", created.task_id);
    await GpuLeaseService.acquireLease(created.task_id, 'video');
    await pipeline.call(service, created.task_id, submitted);
    assert.equal(GpuLeaseService.getCurrentLease(), null);
    assert.equal((await db.get('SELECT status FROM generation_task WHERE task_id=?', created.task_id)).status, 'failed');
  } finally {
    service.runTaskPipeline = pipeline;
    setVideoMotionTranslatorForTests(null);
    GpuLeaseService.resetForTesting();
    if (oldFlag === undefined) delete process.env.NOVASTORY_ENABLE_VIDEO; else process.env.NOVASTORY_ENABLE_VIDEO = oldFlag;
  }
});

test('video motion only recomputes for affected materials or an explicitly selected alternative', async () => {
  let calls = 0;
  setVideoMotionTranslatorForTests(async () => `A hero walks in a courtyard, version ${++calls}.`);
  const request = VideoGenerationRequestSchema.parse({ scene_id: 99 });
  const scene = { id: 99, visual_prompt: 'A hero walks.', shot_spec: JSON.stringify({ primary_action: 'A hero walks.', location: 'courtyard' }) };
  try {
    await Promise.all([VideoSpecCompiler.compile({ request, scene }), VideoSpecCompiler.compile({ request, scene })]);
    await VideoSpecCompiler.compile({ request: { ...request, seed: 5, preset: 'preview_480p_5s' }, scene: { ...scene, audio_prompt: 'bell' } });
    assert.equal(calls, 1);
    await VideoSpecCompiler.compile({ request, scene: { ...scene, camera_angle: 'Low-angle' } });
    await VideoSpecCompiler.compile({ request, scene: { ...scene, camera_movement: 'slow pan' } });
    await VideoSpecCompiler.compile({ request, scene, style: { style: 'moonlight' } });
    await VideoSpecCompiler.compile({ request, scene, character: { name: 'Hero', visual_tags: { hair: 'white' } } });
    await VideoSpecCompiler.compile({ request, scene: { ...scene, shot_spec: JSON.stringify({ primary_action: 'A hero walks.', location: 'courtyard', continuity_states: [{ entity: 'Hero', attribute: 'holding', value: 'cup' }] }) } });
    assert.equal(calls, 6);
    const alternative = { ...request, inference_variant: 'new-version' };
    await VideoSpecCompiler.compile({ request: alternative, scene });
    await VideoSpecCompiler.compile({ request: alternative, scene });
    assert.equal(calls, 7);
  } finally { setVideoMotionTranslatorForTests(null); }
});
