import '../../test_setup';
import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb } from '../../db/database';
import { VideoGenerationService } from './video_generation_service';
import { VideoGenerationRequestSchema } from '../../schemas/video';
import { GpuLeaseService } from '../gpu_lease_service';

test('video retries replay one task even when preflight resolves a missing keyframe ID', async () => {
  await initDb();
  const originalPreflight = VideoGenerationService.preflight;
  const pipelineService = VideoGenerationService as any;
  const originalPipeline = pipelineService.runTaskPipeline;
  const originalLease = GpuLeaseService.acquireLease;
  let preflights = 0; let pipelines = 0;
  VideoGenerationService.preflight = async request => { preflights++; request.keyframe_asset_id = 909; return { ready: true, blockers: [], warnings: [] } as any; };
  pipelineService.runTaskPipeline = async () => { pipelines++; };
  GpuLeaseService.acquireLease = async () => ({}) as any;
  try {
    const input = () => VideoGenerationRequestSchema.parse({ scene_id: 9101, request_key: 'video-idempotency-test' });
    const [a, b] = await Promise.all([VideoGenerationService.createTask(input()), VideoGenerationService.createTask(input())]);
    assert.equal(a.task_id, b.task_id); assert.equal(preflights, 1); assert.equal(pipelines, 1);
    await assert.rejects(() => VideoGenerationService.createTask({ ...input(), seed: 5 }), /different parameters/);
  } finally { VideoGenerationService.preflight = originalPreflight; pipelineService.runTaskPipeline = originalPipeline; GpuLeaseService.acquireLease = originalLease; }
});
