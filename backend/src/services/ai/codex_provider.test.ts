import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider } from './codex_provider';

test('a timed-out Codex image job can be reattached only to the matching request', async () => {
  const queue = fs.mkdtempSync(path.join(os.tmpdir(), 'novastory-codex-resume-'));
  const previous = process.env.NOVASTORY_CODEX_IMAGE_QUEUE_DIR;
  process.env.NOVASTORY_CODEX_IMAGE_QUEUE_DIR = queue;
  const id = '00ad0777-38f0-4d73-87bf-08d880f4d891';
  const prompt = 'A wooden village bucket';
  const options = { width: 768, height: 1344, aspectRatio: '9:16' as const, imageSize: '1K' as const, referenceImagePaths: [] };
  const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1024)]);
  try {
    fs.writeFileSync(path.join(queue, `${id}.request.json`), JSON.stringify({ id, kind: 'image', prompt, options }));
    fs.writeFileSync(path.join(queue, `${id}.result.json`), JSON.stringify({ id, status: 'completed' }));
    fs.writeFileSync(path.join(queue, `${id}.png`), image);
    const provider = new CodexProvider();
    const resumed = await provider.generateImage(prompt, { ...options, resumeJobId: id });
    assert.deepEqual(resumed.data, image);
    const wrongPrompt = await provider.generateImage('Another prop', { ...options, resumeJobId: id });
    assert.match(wrongPrompt.error || '', /does not match/);
    const wrongOptions = await provider.generateImage(prompt, { ...options, width: 512, resumeJobId: id });
    assert.match(wrongOptions.error || '', /does not match/);
  } finally {
    if (previous == null) delete process.env.NOVASTORY_CODEX_IMAGE_QUEUE_DIR;
    else process.env.NOVASTORY_CODEX_IMAGE_QUEUE_DIR = previous;
    fs.rmSync(queue, { recursive: true, force: true });
  }
});
