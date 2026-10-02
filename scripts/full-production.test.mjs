import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { resolveAssetBindings, keyframeUsesBindings, resolveVisibleShotCharacters, resolveTimedOutCodexJobId } from './production-references.mjs';

test('visible shot references prioritize the focal character and exclude uncast extras', () => {
  const shot = { shot_spec: { primary_subject: '陆青', visible_subjects: ['老葛', '陆青', '沈砚', '周槐'] } };
  const characters = [
    { id: 27, name: '沈砚', avatar_url: '/shen.png' },
    { id: 29, name: '周槐', avatar_url: '/zhou.png' },
    { id: 30, name: '陆青', avatar_url: '/lu.png' },
  ];
  assert.deepEqual(resolveVisibleShotCharacters(shot, characters).map(character => character.id), [30, 27, 29]);
});

test('only a timed-out Codex image job is eligible for exact system recovery', () => {
  assert.equal(resolveTimedOutCodexJobId('Codex image job 83f738da-e10f-4183-81a1-5e719caf9af7 timed out; request preserved'), '83f738da-e10f-4183-81a1-5e719caf9af7');
  assert.equal(resolveTimedOutCodexJobId('Image provider denied request'), null);
});

async function fixture(handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nova-production-test-'));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { const result = await handler(req.url, req.method, raw ? JSON.parse(raw) : undefined); res.writeHead(result.status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body)); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    directory,
    async run(stage, extra = [], env = {}) {
      const child = spawn(process.execPath, ['scripts/full-production.mjs', '--stage', stage, '--base-url', base, '--output', directory, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); return { code, output };
    },
    async close() { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); },
  };
}

test('unavailable generation dependencies stop the full pipeline and remain visible in escaped reports', async () => {
  let generationCalls = 0;
  const f = await fixture((url) => {
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui' } };
    if (url.includes('/settings/verify')) return { status: 502, body: { detail: '<script>upstream offline</script>' } };
    if (url.includes('/videos/capabilities')) return { body: { video_generation_enabled: false, missing_components: ['ComfyUI offline'] } };
    if (url.includes('/asset-library')) return { body: [] };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, title: '凡间之上' } };
    generationCalls++; return { status: 500, body: { error: 'should not generate' } };
  });
  try {
    const result = await f.run('all'); assert.equal(result.code, 1); assert.equal(generationCalls, 0);
    const report = await readFile(path.join(f.directory, 'report.html'), 'utf8');
    assert.match(report, /尚未完成/); assert.match(report, /&lt;script&gt;/); assert.doesNotMatch(report, /<script>/);
    const state = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')); assert.ok(state.preflight.blockers.length >= 3);
  } finally { await f.close(); }
});

test('existing finalized chapters are preserved on rerun without extra chapters or duplicate inference', async () => {
  const content = '山风吹过石阶，铜铃仍在掌心。'.repeat(120);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const chapters = Array.from({ length: 5 }, (_, i) => ({ id: `ch-${i}`, index: i + 1, content, title: `第${i + 1}章`, status: 'completed', finalized_content_hash: contentHash }));
  let brainstorms = 0; const mutations = [];
  const f = await fixture((url, method) => {
    if (url === '/api/assistant/chat') { brainstorms++; return { body: { response: '五章构思' } }; }
    if (url === '/api/agent/consistency') return { body: { issues: [] } };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, title: '凡间之上' } };
    if (method !== 'GET') mutations.push(url);
    if (url.includes('/story-plan')) return { body: { document: { blueprint: { title: '凡间之上' } }, entries: chapters.map(c => ({ id: c.id, disposition: 'active', summary: '已有规划' })) } };
    if (url.startsWith('/api/chapters/')) return { body: chapters };
    return { status: 500, body: { error: 'unexpected endpoint' } };
  });
  try {
    assert.equal((await f.run('text')).code, 0); assert.equal((await f.run('text')).code, 0);
    assert.equal(brainstorms, 1); assert.deepEqual(mutations, []);
    assert.equal(await readFile(path.join(f.directory, '03-chapter-5.txt'), 'utf8'), content);
  } finally { await f.close(); }
});

test('failed video tasks keep their identity until an explicit retry allocates a new request', async () => {
  let submissions = 0; const requestKeys = [];
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, active_version: 1 }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    if (url === '/api/videos/generate') { submissions++; requestKeys.push(body.request_key); return { body: { task_id: `task-${submissions}` } }; }
    if (url.startsWith('/api/videos/tasks/')) return { body: url.endsWith('task-1') ? { status: 'failed', error: 'GPU unavailable' } : { status: 'completed', stage: 'completed' } };
    return { status: 500, body: { error: `unexpected endpoint ${url}` } };
  });
  try {
    assert.equal((await f.run('videos')).code, 1); assert.equal(submissions, 1);
    assert.equal((await f.run('videos')).code, 1); assert.equal(submissions, 1);
    const retried = await f.run('videos', ['--retry-failed']);
    assert.equal(retried.code, 1); assert.match(retried.output, /visual review/); assert.equal(submissions, 2);
    assert.notEqual(requestKeys[0], requestKeys[1]);
  } finally { await f.close(); }
});

test('chapter limit stops the original video workflow after the selected chapters', async () => {
  const submissions = [];
  const preflightScenes = [];
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [1, 2, 3].map(index => ({ id: `ch-${index}`, index })) };
    if (url.startsWith('/api/timeline/ch-')) {
      const index = Number(url.at(-1));
      return { body: { timeline: [{ id: 60 + index, chapter_id: `ch-${index}`, active_version: 1, asset_status: 'completed', asset_url: `/static/shot-${index}.png` }] } };
    }
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url === '/api/videos/preflight') { preflightScenes.push(body.scene_id); return { body: { ready: true, blockers: [] } }; }
    if (url === '/api/videos/generate') { submissions.push(body.scene_id); return { body: { task_id: `task-${body.scene_id}` } }; }
    if (url.startsWith('/api/videos/tasks/')) return { body: { status: 'completed', stage: 'completed' } };
    return { status: 500, body: { error: `unexpected endpoint ${url}` } };
  });
  try {
    assert.equal((await f.run('video-preflight', ['--chapter-limit', '2'])).code, 0);
    assert.deepEqual(preflightScenes, [61, 62]);
    const evidence = JSON.parse(await readFile(path.join(f.directory, '09-video-preflight.json'), 'utf8'));
    assert.equal(evidence.chapterLimit, 2);
    assert.deepEqual(evidence.results.map(result => result.scene_id), [61, 62]);
    const result = await f.run('videos', ['--chapter-limit', '2']);
    assert.equal(result.code, 1);
    assert.match(result.output, /visual review/);
    assert.deepEqual(submissions, [61, 62]);
    const state = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
    assert.equal(state.chapterLimit, 2);
  } finally { await f.close(); }
});

test('video preflight requires a portrait reference for the primary character', async () => {
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1', index: 1 }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 66, chapter_id: 'ch-1', active_version: 1, asset_status: 'completed', asset_url: '/static/66.png', shot_spec: { primary_subject: '老葛' } }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [{ id: 31, name: '老葛' }] };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    return { status: 500, body: { error: `unexpected endpoint ${url}` } };
  });
  try {
    const result = await f.run('video-preflight', ['--chapter-limit', '2']);
    assert.equal(result.code, 1);
    const evidence = JSON.parse(await readFile(path.join(f.directory, '09-video-preflight.json'), 'utf8'));
    assert.equal(evidence.results[0].identity_ready, false);
    assert.equal(evidence.results[0].ready, false);
  } finally { await f.close(); }
});

test('every named asset is bound by kind, with explicit alias bindings reserved independently', () => {
  const assets = [
    { id: 1, kind: 'location', name: '山庙', status: 'completed', image_url: '/static/temple.png' },
    { id: 2, kind: 'prop', name: '铜铃', status: 'completed', image_url: '/static/bell.png' },
    { id: 3, kind: 'prop', name: '红绳', status: 'completed', image_url: '/static/cord.png' },
    { id: 4, kind: 'prop', name: '山庙', status: 'completed', image_url: '/static/model.png' },
  ];
  const shot = { shot_spec: { location: '山庙', key_props: ['铜铃', '红绳'] } };
  assert.deepEqual(resolveAssetBindings(shot, assets).asset_ids, [1, 2, 3]);
  assert.match(resolveAssetBindings(shot, assets, [assets[0]]).blockers.join(';'), /铜铃.*红绳/);
  const alias = { shot_spec: { location: '旧庙', key_props: ['系铃绳', '铜铃'] } };
  assert.equal(resolveAssetBindings(alias, assets, assets.slice(0, 3)).blockers.length, 0);
  assert.match(resolveAssetBindings(alias, assets, assets.slice(0, 2)).blockers.join(';'), /系铃绳/);
  const current = { id: 51, asset_url: '/static/frame.png' };
  const snapshots = [{ scene_id: 51, image_url: current.asset_url, references_json: JSON.stringify([{ id: 1, revision: 1 }, { id: 2, revision: 2 }]) }];
  assert.equal(keyframeUsesBindings(current, [{ id: 2, revision: 2 }, { id: 1, revision: 1 }], snapshots), true);
  assert.equal(keyframeUsesBindings(current, [{ id: 1, revision: 1 }, { id: 2, revision: 3 }], snapshots), false);
  assert.equal(keyframeUsesBindings(current, [{ id: 1, revision: 1 }], snapshots), false);
});

test('partial location matches never start keyframe generation or silently omit a prop', async () => {
  let generationCalls = 0;
  const f = await fixture(url => {
    if (url.includes('/asset-library')) return { body: [{ id: 1, kind: 'location', name: '山庙' }] };
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, shot_spec: { location: '山庙', key_props: ['铜铃'] } }] } };
    if (url.endsWith('/asset-references')) return { body: [] };
    if (url.endsWith('/export')) return { body: {} };
    generationCalls++; return { status: 500, body: { error: 'must not generate' } };
  });
  try {
    const result = await f.run('images'); assert.equal(result.code, 1);
    assert.match(result.output, /铜铃/); assert.equal(generationCalls, 0);
  } finally { await f.close(); }
});

test('the focus character selects its own portrait references regardless of cast database order', async () => {
  let selected;
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, active_version: 1, shot_spec: { primary_subject: '阿风', visible_subjects: ['阿宁', '阿风'] } }] } };
    if (url.includes('/media?')) return { body: { assets: [
      { id: 81, character_id: 1, role: 'character_reference', status: 'ready' },
      { id: 82, character_id: 2, role: 'character_reference', status: 'ready' },
    ] } };
    if (url.startsWith('/api/characters/')) return { body: [{ id: 1, name: '阿宁' }, { id: 2, name: '阿风' }] };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    if (url === '/api/videos/generate') { selected = body.character_reference_asset_ids; return { body: { task_id: 'focus-task' } }; }
    if (url === '/api/videos/tasks/focus-task') return { body: { status: 'completed', stage: 'completed' } };
    return { status: 500, body: { error: `unexpected endpoint ${url}` } };
  });
  try { const result = await f.run('videos'); assert.equal(result.code, 1); assert.match(result.output, /visual review/); assert.deepEqual(selected, [82]); }
  finally { await f.close(); }
});

test('a named character without identity references stops before video inference', async () => {
  let submissions = 0;
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, shot_spec: { primary_subject: '阿风' } }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [{ id: 2, name: '阿风' }] };
    submissions++; return { status: 500, body: { error: 'must not infer' } };
  });
  try { const result = await f.run('videos'); assert.equal(result.code, 1); assert.match(result.output, /阿风/); assert.equal(submissions, 0); }
  finally { await f.close(); }
});

test('identity acceptance checks the actual generated manifest instead of merely counting portrait files', async () => {
  const scene = { id: 51, chapter_id: 'ch-1', active_version: 1, asset_url: '/static/frame.png', shot_spec: { primary_subject: '阿风' } };
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/?')) return { body: [{ id: 'ch-1', target_word_count: 1600 }] };
    if (url.endsWith('/story-plan')) return { body: { document: { blueprint: { characters: [] } }, entries: [] } };
    if (url.startsWith('/api/characters/')) return { body: [{ id: 2, name: '阿风' }] };
    if (url.includes('/asset-library')) return { body: [] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [scene] } };
    if (url.endsWith('/script')) return { body: { script: null } };
    if (url.endsWith('/asset-references')) return { body: [] };
    if (url.endsWith('/export')) return { body: {} };
    if (url.includes('/media?')) return { body: { assets: [
      { id: 90, role: 'narrative_final', status: 'ready', url: '/static/task/final.mp4' },
      { id: 81, character_id: 1, role: 'character_reference', status: 'ready' },
      { id: 82, character_id: 2, role: 'character_reference', status: 'ready' },
      { id: 83, role: 'video_keyframe', status: 'ready', url: scene.asset_url },
    ] } };
    return { status: 500, body: { error: `unexpected endpoint ${url}` } };
  });
  try {
    await mkdir(path.join(f.directory, 'task'));
    // This empty fixture is deliberately not a real video: all media/content gates
    // still fail. Only the independent identity-provenance requirement is exercised.
    await writeFile(path.join(f.directory, 'task/final.mp4'), '');
    const manifest = (refs, keyframe = 83) => writeFile(path.join(f.directory, 'task/manifest.json'), JSON.stringify({ metadata: { request: { character_reference_asset_ids: refs, keyframe_asset_id: keyframe, scene_id: 51, scene_version: 1 } } }));
    await manifest([81]); await f.run('verify', [], { NOVASTORY_STATIC_DIR: f.directory });
    let acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(a => a.id === 'F13').status, 'FAIL');
    await manifest([82]); await f.run('verify', [], { NOVASTORY_STATIC_DIR: f.directory });
    acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(a => a.id === 'F13').status, 'PASS');
    assert.equal(acceptance.find(a => a.id === 'F02').status, 'FAIL');
    assert.equal(acceptance.find(a => a.id === 'F12').status, 'FAIL');
    assert.equal(acceptance.find(a => a.id === 'F14').status, 'PASS');
    await manifest([82], 84); await f.run('verify', [], { NOVASTORY_STATIC_DIR: f.directory });
    acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(a => a.id === 'F14').status, 'FAIL');
  } finally { await f.close(); }
});

test('changing a keyframe creates one new video task while an unchanged resume never duplicates inference', async () => {
  let keyframe = '/static/frame-v1.png';
  const requests = [];
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, active_version: 1, asset_url: keyframe }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    if (url === '/api/videos/generate') { requests.push(body); return { body: { task_id: `task-${requests.length}` } }; }
    if (url.startsWith('/api/videos/tasks/')) return { body: { status: 'completed', stage: 'completed' } };
    return { status: 500, body: { error: `unexpected endpoint ${url}` } };
  });
  try {
    await f.run('videos'); await f.run('videos'); assert.equal(requests.length, 1);
    keyframe = '/static/frame-v2.png'; await f.run('videos'); await f.run('videos');
    assert.equal(requests.length, 2); assert.notEqual(requests[0].request_key, requests[1].request_key);
  } finally { await f.close(); }
});
