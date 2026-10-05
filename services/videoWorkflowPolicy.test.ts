import assert from 'node:assert/strict';
import test from 'node:test';
import { appendUploadedIdentityReference, defaultIdentityReferenceIds, readProjectVideoWorkflow, recommendVideoWorkflow, resolveProjectVideoWorkflow } from './videoWorkflowPolicy';
import type { MediaAsset } from '../types';

const asset = (role: MediaAsset['role']): MediaAsset => ({
  id: 1, project_id: 1, media_type: role === 'motion_reference' ? 'video' : 'image',
  role, status: 'ready', url: '/test',
});

test('default identity uses two recent views of only one character', () => {
  const refs = [
    { ...asset('character_reference'), id: 10, character_id: 1 },
    { ...asset('character_reference'), id: 11, character_id: 2 },
    { ...asset('character_reference'), id: 12, character_id: 1 },
    { ...asset('character_reference'), id: 13, character_id: 1 },
  ];
  assert.deepEqual(defaultIdentityReferenceIds(refs), [13, 12]);
});

test('consecutive identity uploads append same or unbound views and replace a different character', () => {
  const first = { ...asset('character_reference'), id: 10, character_id: 1 };
  const second = { ...first, id: 11 };
  const third = { ...first, id: 12 };
  const unbound = { ...first, id: 13, character_id: null };
  const other = { ...first, id: 14, character_id: 2 };
  assert.deepEqual(appendUploadedIdentityReference([10], [first], second), [10, 11]);
  assert.deepEqual(appendUploadedIdentityReference([10, 11], [first, second], unbound), [10, 11, 13]);
  assert.deepEqual(appendUploadedIdentityReference([10, 11, 13], [first, second, unbound], third), [11, 13, 12]);
  assert.deepEqual(appendUploadedIdentityReference([10, 11], [first, second], other), [14]);
});

test('official workflow recommendation follows guide, boundary, and ordinary shot roles', () => {
  assert.equal(recommendVideoWorkflow([]).workflowId, 'minimax_h3_ref2va_official_12gb');
  assert.equal(recommendVideoWorkflow([asset('character_reference')]).workflowId, 'minimax_h3_ref2va_official_12gb');
  assert.equal(recommendVideoWorkflow([asset('last_frame_reference'), asset('character_reference')]).workflowId, 'minimax_h3_fl2va_official_12gb');
  assert.equal(recommendVideoWorkflow([asset('guide_frame_reference'), asset('last_frame_reference')]).workflowId, 'minimax_h3_multiframe_official_12gb');
  assert.equal(recommendVideoWorkflow([{ ...asset('guide_frame_reference'), status: 'draft' }]).workflowId, 'minimax_h3_ref2va_official_12gb');
});

test('project video default replaces ordinary shots and yields to frame boundaries', () => {
  assert.equal(readProjectVideoWorkflow({ video_generation: { workflow_id: 'grok_imagine_browser' } }), 'grok_imagine_browser');
  assert.equal(readProjectVideoWorkflow({ video_generation: { workflow_id: 'not-a-workflow' } }), null);
  assert.equal(resolveProjectVideoWorkflow([], 'minimax_h3_hongchao_a2a_12gb').workflowId, 'minimax_h3_hongchao_a2a_12gb');
  assert.equal(resolveProjectVideoWorkflow([asset('last_frame_reference')], 'grok_imagine_browser').workflowId, 'minimax_h3_fl2va_official_12gb');
  assert.equal(resolveProjectVideoWorkflow([asset('guide_frame_reference')], 'minimax_h3_hongchao_a2a_12gb').workflowId, 'minimax_h3_multiframe_official_12gb');
});
