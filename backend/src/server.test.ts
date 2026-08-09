import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL = ':memory:';

test('full application exposes parity routes and API documentation', async () => {
  const { buildApp } = await import('./server');
  const app = await buildApp({ logger: false });

  try {
    await app.ready();

    const openApiResponse = await app.inject({
      method: 'GET',
      url: '/openapi.json'
    });
    assert.equal(openApiResponse.statusCode, 200);

    const document = openApiResponse.json();
    const mainBaselineOperations: Array<[string, string]> = [
      ['post', '/api/assistant/chat'],
      ['post', '/api/assets/generate'],
      ['get', '/api/assets/status/{task_id}'],
      ['get', '/api/assets/stream/{task_id}'],
      ['post', '/api/assets/cancel'],
      ['post', '/api/characters/extract'],
      ['post', '/api/characters/'],
      ['get', '/api/characters/'],
      ['get', '/api/characters/{id}'],
      ['put', '/api/characters/{id}'],
      ['delete', '/api/characters/{id}'],
      ['post', '/api/characters/{id}/build-prompt'],
      ['post', '/api/characters/{id}/crop-face'],
      ['post', '/api/characters/{id}/train-lora'],
      ['post', '/api/characters/upload-image'],
      ['post', '/api/characters/{id}/upload-asset'],
      ['post', '/api/comics/{chapter_id}/generate'],
      ['post', '/api/scenes/{scene_id}/coverage'],
      ['get', '/api/scenes/{scene_id}/coverage'],
      ['post', '/api/scenes/coverage/{shot_id}/apply'],
      ['post', '/api/scenes/coverage/{shot_id}/promote'],
      ['post', '/api/agent/storyboard-grid'],
      ['post', '/api/agent/draft'],
      ['post', '/api/agent/analyze'],
      ['get', '/api/agent/context/{chapter_id}'],
      ['post', '/api/projects/import'],
      ['post', '/api/projects/'],
      ['get', '/api/projects/'],
      ['get', '/api/projects/{id}'],
      ['put', '/api/projects/{id}'],
      ['delete', '/api/projects/{id}'],
      ['get', '/api/settings/'],
      ['post', '/api/settings/'],
      ['post', '/api/settings/verify-llm'],
      ['post', '/api/chapters/'],
      ['get', '/api/chapters/'],
      ['delete', '/api/chapters/{id}'],
      ['patch', '/api/chapters/{id}'],
      ['put', '/api/chapters/{id}/move'],
      ['get', '/api/timeline/{chapter_id}'],
      ['post', '/api/timeline/generate'],
      ['put', '/api/timeline/scene/{scene_id}'],
      ['get', '/api/workflows/files'],
      ['post', '/api/workflows/'],
      ['get', '/api/workflows/'],
      ['get', '/api/workflows/{id}'],
      ['put', '/api/workflows/{id}'],
      ['delete', '/api/workflows/{id}']
    ];
    assert.equal(mainBaselineOperations.length, 48);
    for (const [method, routePath] of mainBaselineOperations) {
      assert.ok(
        document.paths[routePath]?.[method],
        `OpenAPI is missing ${method.toUpperCase()} ${routePath}`
      );
    }

    const docsResponse = await app.inject({
      method: 'GET',
      url: '/docs/'
    });
    assert.equal(docsResponse.statusCode, 200);
    assert.match(docsResponse.body, /swagger-ui/i);

    const invalidDraftResponse = await app.inject({
      method: 'POST',
      url: '/api/agent/draft',
      payload: {}
    });
    assert.equal(invalidDraftResponse.statusCode, 422);
    assert.ok(Array.isArray(invalidDraftResponse.json().detail));

    const { AssetTaskStore } = await import('./services/task_store');
    await AssetTaskStore.completed('sse-regression', 1, '/static/generated/test.png');
    const sseResponse = await app.inject({
      method: 'GET',
      url: '/api/assets/stream/sse-regression',
      headers: { origin: 'http://localhost:3000' }
    });
    assert.equal(sseResponse.statusCode, 200);
    assert.equal(sseResponse.headers['content-type'], 'text/event-stream');
    assert.equal(sseResponse.headers['access-control-allow-origin'], '*');
    assert.match(sseResponse.body, /"status":"completed"/);
  } finally {
    await app.close();
  }
});
