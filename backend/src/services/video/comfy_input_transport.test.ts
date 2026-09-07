import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComfyInputTransport,
  isLoopbackComfyUrl,
  normalizeReferenceTransportMode,
  shouldUseHttpReferenceTransport
} from './comfy_input_transport';

const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' }
});

test('Comfy reference transport policy prefers filesystem locally and HTTP remotely', () => {
  assert.equal(normalizeReferenceTransportMode(undefined), 'auto');
  assert.equal(normalizeReferenceTransportMode('HTTP'), 'http');
  assert.equal(normalizeReferenceTransportMode('filesystem'), 'filesystem');
  assert.equal(normalizeReferenceTransportMode('unknown'), 'auto');

  assert.equal(isLoopbackComfyUrl('http://127.0.0.1:8188'), true);
  assert.equal(isLoopbackComfyUrl('http://localhost:8188'), true);
  assert.equal(isLoopbackComfyUrl('http://192.168.1.25:8188'), false);

  assert.equal(shouldUseHttpReferenceTransport({
    mode: 'auto',
    baseUrl: 'http://192.168.1.25:8188',
    filesystemAvailable: false
  }), true);
  assert.equal(shouldUseHttpReferenceTransport({
    mode: 'auto',
    baseUrl: 'http://127.0.0.1:8188',
    filesystemAvailable: false,
    comfyEnabled: false
  }), false);
  assert.equal(shouldUseHttpReferenceTransport({
    mode: 'auto',
    baseUrl: 'http://127.0.0.1:8188',
    filesystemAvailable: false,
    comfyEnabled: true
  }), true);
  assert.equal(shouldUseHttpReferenceTransport({
    mode: 'auto',
    baseUrl: 'http://192.168.1.25:8188',
    filesystemAvailable: true
  }), false);
  assert.equal(shouldUseHttpReferenceTransport({
    mode: 'http',
    baseUrl: 'http://127.0.0.1:8188',
    filesystemAvailable: true
  }), true);
  assert.equal(shouldUseHttpReferenceTransport({
    mode: 'filesystem',
    baseUrl: 'http://192.168.1.25:8188',
    filesystemAvailable: false
  }), false);
});

test('ComfyInputTransport uploads reference bytes into an isolated Comfy input subfolder', async () => {
  const originalFetch = global.fetch;
  let capturedUrl = '';
  let capturedForm: FormData | null = null;

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedForm = init?.body as FormData;
    return jsonResponse({
      name: 'abc123_ref.mp4',
      subfolder: 'novastory',
      type: 'input'
    });
  }) as typeof fetch;

  try {
    const result = await ComfyInputTransport.uploadInput({
      baseUrl: 'http://10.10.0.8:8188/',
      filename: 'abc123_ref.mp4',
      buffer: Buffer.from([0, 1, 2, 3, 4]),
      mimeType: 'video/mp4',
      subfolder: 'novastory',
      timeoutMs: 1000
    });

    assert.equal(capturedUrl, 'http://10.10.0.8:8188/upload/image');
    assert.ok(capturedForm instanceof FormData);
    assert.equal(capturedForm?.get('type'), 'input');
    assert.equal(capturedForm?.get('overwrite'), 'true');
    assert.equal(capturedForm?.get('subfolder'), 'novastory');
    const file = capturedForm?.get('image') as any;
    assert.equal(file?.name, 'abc123_ref.mp4');
    assert.equal(file?.type, 'video/mp4');
    assert.equal(result.inputName, 'novastory/abc123_ref.mp4');
    assert.equal(result.type, 'input');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ComfyInputTransport fails closed when remote upload is rejected', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response('upload disabled', { status: 403 })) as typeof fetch;

  try {
    await assert.rejects(
      ComfyInputTransport.uploadInput({
        baseUrl: 'http://10.10.0.8:8188',
        filename: 'ref.png',
        buffer: Buffer.from('png'),
        mimeType: 'image/png',
        timeoutMs: 1000
      }),
      /ComfyUI reference upload failed \(403\)/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
