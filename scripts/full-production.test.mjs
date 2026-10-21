import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { resolveAssetBindings, keyframeUsesBindings, keyframeUsesCharacterVersions, chooseShotVideoStrategy, resolveVisibleShotCharacters, resolveVisibleShotCast, resolveTimedOutCodexJobId, coreCharactersReadyForAcceptance, platesFromCharacter, selectIdentityReferenceIds } from './production-references.mjs';

test('pinned face and body plates beat a newer portrait with no slot', () => {
  const refs = [
    { id: 12, role: 'character_reference', status: 'ready', character_id: 1, url: '/body.png', metadata_json: JSON.stringify({ source_slot: 'body' }) },
    { id: 13, role: 'character_reference', status: 'ready', character_id: 1, url: '/face.png', metadata_json: JSON.stringify({ source_slot: 'face' }) },
    { id: 14, role: 'character_reference', status: 'ready', character_id: 1, url: '/new.png' },
  ];
  assert.deepEqual(selectIdentityReferenceIds(refs, 1), [13, 12]);
  assert.deepEqual(selectIdentityReferenceIds(refs, 1, { face: '/face.png', body: '/body.png' }), [13, 12]);
  const legacy = [
    { id: 12, role: 'character_reference', status: 'ready', character_id: 1, url: '/a.png' },
    { id: 13, role: 'character_reference', status: 'ready', character_id: 1, url: '/b.png' },
  ];
  assert.deepEqual(selectIdentityReferenceIds(legacy, 1), [13, 12]);
  assert.deepEqual(
    platesFromCharacter({ visual_tags: { assets: { avatar_url: '/face.png', turnaround_url: '/sheet.png', turnaround_front_url: '/front.png' } } }),
    { face: '/face.png', body: '/front.png' },
  );
  assert.deepEqual(platesFromCharacter({ avatar_url: '/column.png' }), { face: '/column.png', body: null });
});

test('production requires an explicit project id', async () => {
  const child = spawn(process.execPath, ['scripts/full-production.mjs', '--stage', 'preflight'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 1);
  assert.match(output, /Invalid --project/);
});

test('acceptance requires portraits only for core characters who have appeared', () => {
  const cores = ['阿风', '阿宁'];
  const characters = [
    { name: '阿风', avatar_url: '/a.png', turnaround_url: '/t.png' },
    { name: '阿宁' },
  ];
  const onlyFeng = [{ shot_spec: { primary_subject: '阿风', visible_subjects: [] } }];
  assert.equal(coreCharactersReadyForAcceptance(cores, characters, onlyFeng), true);
  const both = [{ shot_spec: { primary_subject: '阿风', visible_subjects: ['阿宁'] } }];
  assert.equal(coreCharactersReadyForAcceptance(cores, characters, both), false);
});

test('visible shot references prioritize the focal character and exclude uncast extras', () => {
  const shot = { shot_spec: { primary_subject: '陆青', visible_subjects: ['老葛', '陆青', '沈砚', '周槐'] } };
  const characters = [
    { id: 27, name: '沈砚', avatar_url: '/shen.png' },
    { id: 29, name: '周槐', avatar_url: '/zhou.png' },
    { id: 30, name: '陆青', avatar_url: '/lu.png' },
  ];
  assert.deepEqual(resolveVisibleShotCharacters(shot, characters).map(character => character.id), [30, 27, 29]);
  assert.deepEqual(resolveVisibleShotCast(shot, characters).map(character => character.id), [30, 27, 29]);
});

test('chapter assembly rejects a Shot Master after a represented character changes', () => {
  const shot = { id: 9, asset_url: '/shot.png' };
  const snapshots = [{ scene_id: 9, image_url: '/shot.png', character_versions_json: JSON.stringify([{ id: 7, version: 2 }]) }];
  assert.equal(keyframeUsesCharacterVersions(shot, [{ id: 7, active_version: 2 }], snapshots, [7]), true);
  assert.equal(keyframeUsesCharacterVersions(shot, [{ id: 7, active_version: 3 }], snapshots, [7]), false);
  assert.equal(keyframeUsesCharacterVersions(shot, [{ id: 7, active_version: 2 }], snapshots, [8]), false);
});

test('batch video strategy chooses official workflows from scene references', () => {
  const ready = (id, role, metadata_json) => ({ id, role, status: 'ready', metadata_json });
  assert.equal(chooseShotVideoStrategy([]).workflow_id, 'minimax_h3_ref2va_official_12gb');
  const boundary = chooseShotVideoStrategy([ready(11, 'last_frame_reference')]);
  assert.equal(boundary.workflow_id, 'minimax_h3_fl2va_official_12gb');
  assert.equal(boundary.last_frame_asset_id, 11);
  const complex = chooseShotVideoStrategy([ready(11, 'last_frame_reference'), ready(12, 'guide_frame_reference', '{"guide_frame_idx":72}')]);
  assert.equal(complex.workflow_id, 'minimax_h3_multiframe_official_12gb');
  assert.deepEqual(complex.guide_frames, [{ asset_id: 12, frame_idx: 72 }]);
  assert.throws(() => chooseShotVideoStrategy([ready(13, 'guide_frame_reference')]), /requires metadata_json.guide_frame_idx/);
  assert.throws(() => chooseShotVideoStrategy([ready(13, 'guide_frame_reference', '{"guide_frame_idx":120}')]), /within delivery frames 1..119/);
  assert.equal(chooseShotVideoStrategy([{ ...ready(13, 'guide_frame_reference'), status: 'draft' }]).workflow_id, 'minimax_h3_ref2va_official_12gb');
  assert.equal(chooseShotVideoStrategy([ready(12, 'guide_frame_reference')], 'minimax_h3_ref2va_official_12gb').workflow_id, 'minimax_h3_ref2va_official_12gb');
  assert.equal(chooseShotVideoStrategy([], null, 'grok_imagine_browser').workflow_id, 'grok_imagine_browser');
  assert.equal(chooseShotVideoStrategy([ready(11, 'last_frame_reference')], null, 'grok_imagine_browser').workflow_id, 'minimax_h3_fl2va_official_12gb');
});

test('only a timed-out Codex image job is eligible for exact system recovery', () => {
  assert.equal(resolveTimedOutCodexJobId('Codex image job 83f738da-e10f-4183-81a1-5e719caf9af7 timed out; request preserved'), '83f738da-e10f-4183-81a1-5e719caf9af7');
  assert.equal(resolveTimedOutCodexJobId('Image provider denied request'), null);
});

async function fixture(handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nova-production-test-'));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { const result = req.url === '/api/agent/consistency' ? { body: { issues: [] } } : await handler(req.url, req.method, raw ? JSON.parse(raw) : undefined); res.writeHead(result.status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result.body)); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    directory,
    async run(stage, extra = [], env = {}) {
      const child = spawn(process.execPath, ['scripts/full-production.mjs', '--project', '90713823', '--stage', stage, '--base-url', base, '--output', directory, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); return { code, output };
    },
    async close() { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); },
  };
}

test('unavailable generation dependencies stop the full pipeline and remain visible in escaped reports', async () => {
  let generationCalls = 0;
  const f = await fixture((url) => {
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui', comfyui: { enabled: true } } };
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

test('text bootstraps only PLAN_NOT_FOUND and keeps other HTTP failures visible', async () => {
  for (const code of ['PLAN_NOT_FOUND', 'PROJECT_NOT_FOUND']) {
    let bootstrap = 0, existing = false;
    const document = { blueprint: { characters: [] } };
    const content = '已完成正文'.repeat(10);
    const f = await fixture(url => {
      if (url === '/api/settings/') return { body: { llm: { provider: 'ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'novastory-qwen3.5:9b' } } };
      if (url === '/api/projects/90713823') return { body: { title: '新项目' } };
      if (url.endsWith('/story-plan')) return existing ? { body: { document, entries: [{ disposition: 'active', summary: '规划' }] } } : { status: 404, body: { code } };
      if (url.endsWith('/story-plan/bootstrap')) { bootstrap++; existing = true; return { body: { document, entries: [{ disposition: 'active', summary: '规划' }] } }; }
      if (url === '/api/assistant/chat') return { body: { response: '构思' } };
      if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1', index: 1, content, status: 'completed', finalized_content_hash: createHash('sha256').update(content).digest('hex'), target_word_count: 10 }] };
      if (url === '/api/agent/consistency') return { body: { issues: [] } };
      throw new Error(`Unexpected ${url}`);
    });
    try {
      const result = await f.run('text', ['--chapter-limit', '1'], { NOVASTORY_LLM_MODE: '', LLM_MODE: '' });
      assert.equal(result.code, code === 'PLAN_NOT_FOUND' ? 0 : 1, result.output);
      assert.equal(bootstrap, code === 'PLAN_NOT_FOUND' ? 1 : 0);
    } finally { await f.close(); }
  }
});

test('preflight prunes replaced shot failures and blocks only the currently selected result', async () => {
  const f = await fixture(url => {
    if (url === '/api/projects/90713823') return { body: { settings: {} } };
    if (url.startsWith('/api/videos/capabilities')) return { body: { video_generation_enabled: true, missing_components: [] } };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 2, chapter_id: 'ch-1', asset_status: 'completed', asset_url: '/static/frame.png' }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    throw new Error(`Unexpected ${url}`);
  });
  try {
    await writeFile(path.join(f.directory, '09-video-preflight.json'), JSON.stringify({ results: [{ scene_id: 1, ready: false }] }));
    const result = await f.run('video-preflight', ['--chapter-limit', '1', '--chapter-id', 'ch-1']);
    assert.equal(result.code, 0, result.output);
    const evidence = JSON.parse(await readFile(path.join(f.directory, '09-video-preflight.json'), 'utf8'));
    assert.deepEqual(evidence.results.map(result => result.scene_id), [2]);
  } finally { await f.close(); }
});

test('existing finalized chapters are preserved on rerun without extra chapters or duplicate inference', async () => {
  const content = '山风吹过石阶，铜铃仍在掌心。'.repeat(120);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const chapters = Array.from({ length: 5 }, (_, i) => ({ id: `ch-${i}`, index: i + 1, content, title: `第${i + 1}章`, status: 'completed', finalized_content_hash: contentHash }));
  let brainstorms = 0; const mutations = [];
  const f = await fixture((url, method) => {
    if (url === '/api/settings/') return { body: { llm: { provider: 'ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'novastory-qwen3.5:9b' } } };
    if (url === '/api/assistant/chat') { brainstorms++; return { body: { response: '五章构思' } }; }
    if (url === '/api/agent/consistency') return { body: { issues: [] } };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, title: '凡间之上' } };
    if (method !== 'GET') mutations.push(url);
    if (url.includes('/story-plan')) return { body: { document: { blueprint: { title: '凡间之上' } }, entries: chapters.map(c => ({ id: c.id, disposition: 'active', summary: '已有规划' })) } };
    if (url.startsWith('/api/chapters/')) return { body: chapters };
    return { status: 500, body: { error: 'unexpected endpoint' } };
  });
  try {
    assert.equal((await f.run('text', [], { NOVASTORY_LLM_MODE: '', LLM_MODE: '' })).code, 0); assert.equal((await f.run('text', [], { NOVASTORY_LLM_MODE: '', LLM_MODE: '' })).code, 0);
    assert.equal(brainstorms, 1); assert.deepEqual(mutations, []);
    assert.equal(await readFile(path.join(f.directory, '03-chapter-5.txt'), 'utf8'), content);
  } finally { await f.close(); }
});

test('failed video tasks keep their identity until an explicit retry allocates a new request', async () => {
  let submissions = 0; const requestKeys = [];
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, chapter_id: 'ch-1', active_version: 1 }] } };
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

test('chapter limit does not allow the second chapter before the first is accepted', async () => {
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
    assert.deepEqual(submissions, [61]);
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
  assert.deepEqual(resolveAssetBindings({ shot_spec: {} }, assets).blockers, []);
  assert.deepEqual(resolveAssetBindings({ shot_spec: {} }, assets).asset_ids, []);
  assert.match(resolveAssetBindings(shot, assets, [assets[0]]).blockers.join(';'), /铜铃.*红绳/);
  const alias = { shot_spec: { location: '旧庙', key_props: ['系铃绳', '铜铃'] } };
  assert.equal(resolveAssetBindings(alias, assets, assets.slice(0, 3)).blockers.length, 0);
  assert.match(resolveAssetBindings(alias, assets, assets.slice(0, 2)).blockers.join(';'), /系铃绳/);
  const library = [
    { id: 10, kind: 'location', name: '清暮宫玉阶' },
    { id: 11, kind: 'location', name: '花海' },
    { id: 12, kind: 'location', name: '琼明仙域云海' },
    { id: 13, kind: 'prop', name: '合欢香' },
    { id: 14, kind: 'prop', name: '合欢香炉' },
  ];
  const prose = { shot_spec: { location: '清暮宫·玉阶，千瓣花海在云海间齐绽', key_props: ['合欢香还没有点燃'] } };
  assert.deepEqual(resolveAssetBindings(prose, library).asset_ids, [10, 13]);
  const mirrors = [
    { id: 20, kind: 'prop', name: '神镜碎片' },
    { id: 21, kind: 'prop', name: '神镜' },
  ];
  assert.deepEqual(resolveAssetBindings({ shot_spec: { key_props: ['神镜'] } }, mirrors).asset_ids, [21]);
  assert.deepEqual(resolveAssetBindings({ shot_spec: { key_props: ['神镜'] } }, [mirrors[0]]).asset_ids, []);
  assert.match(resolveAssetBindings({ shot_spec: { key_props: ['神镜'] } }, [mirrors[0]]).blockers.join(';'), /神镜/);
  const current = { id: 51, asset_url: '/static/frame.png' };
  const snapshots = [{ scene_id: 51, image_url: current.asset_url, references_json: JSON.stringify([{ id: 1, revision: 1 }, { id: 2, revision: 2 }]) }];
  assert.equal(keyframeUsesBindings(current, [{ id: 2, revision: 2 }, { id: 1, revision: 1 }], snapshots), true);
  assert.equal(keyframeUsesBindings(current, [{ id: 1, revision: 1 }, { id: 2, revision: 3 }], snapshots), false);
  assert.equal(keyframeUsesBindings(current, [{ id: 1, revision: 1 }], snapshots), false);
});

test('partial location matches never start keyframe generation or silently omit a prop', async () => {
  let generationCalls = 0;
  const f = await fixture(url => {
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui', comfyui: { enabled: true } } };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, settings: {} } };
    if (url.includes('/asset-library')) return { body: [{ id: 1, kind: 'location', name: '山庙' }] };
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, chapter_id: 'ch-1', shot_spec: { location: '山庙', key_props: ['铜铃'] } }] } };
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
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, chapter_id: 'ch-1', active_version: 1, shot_spec: { primary_subject: '阿风', visible_subjects: ['阿宁', '阿风'] } }] } };
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
    if (url === '/api/projects/90713823') return { body: { id: 90713823, settings: '{}' } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, chapter_id: 'ch-1', shot_spec: { primary_subject: '阿风' } }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [{ id: 2, name: '阿风' }] };
    submissions++; return { status: 500, body: { error: 'must not infer' } };
  });
  try { const result = await f.run('videos'); assert.equal(result.code, 1); assert.match(result.output, /阿风/); assert.equal(submissions, 0); }
  finally { await f.close(); }
});

test('identity acceptance checks the actual generated manifest instead of merely counting portrait files', async () => {
  const scene = { id: 51, chapter_id: 'ch-1', active_version: 1, asset_url: '/static/frame.png', shot_spec: { primary_subject: '阿风' } };
  const script = { id: 10, revision: 2, status: 'confirmed', document: { scenes: [{ id: 'sc-1', blocks: [{ id: 'b-1' }] }] } };
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/?')) return { body: [{ id: 'ch-1', target_word_count: 1600 }] };
    if (url.endsWith('/story-plan')) return { body: { document: { blueprint: { characters: [] } }, entries: [] } };
    if (url.startsWith('/api/characters/')) return { body: [{ id: 2, name: '阿风' }] };
    if (url.includes('/asset-library')) return { body: [] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [scene] } };
    if (url.endsWith('/script')) return { body: { script } };
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
    scene.shot_spec.source = { type: 'script', script_id: 10, script_revision: 1, script_scene_id: 'sc-1', block_ids: ['b-1'] };
    await f.run('verify', [], { NOVASTORY_STATIC_DIR: f.directory });
    acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(a => a.id === 'F15').status, 'FAIL');
    scene.shot_spec.source.script_revision = 2;
    await f.run('verify', [], { NOVASTORY_STATIC_DIR: f.directory });
    acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(a => a.id === 'F15').status, 'PASS');
    scene.shot_spec.source.block_ids = ['removed-block'];
    await f.run('verify', [], { NOVASTORY_STATIC_DIR: f.directory });
    acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(a => a.id === 'F15').status, 'FAIL');
  } finally { await f.close(); }
});

test('scene images stop when the formal combination is not live verified', async () => {
  const calls = [];
  const f = await fixture((url, method) => {
    calls.push(`${method} ${url}`);
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui', comfyui: { enabled: true } } };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, title: '测试', settings: {} } };
    if (url.startsWith('/api/chapters/?')) return { body: [{ id: 'ch-1', index: 1, title: '第一章', content: '山风吹过石阶。', status: 'completed', finalized_content_hash: 'abc' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 71, chapter_id: 'ch-1', index: 1, asset_status: 'pending', shot_spec: { source: { type: 'script', script_id: 10, script_scene_id: 'sc-1', block_ids: [] } } }] } };
    if (url.includes('/asset-library')) return { body: [] };
    if (url.endsWith('/asset-references')) return { body: [] };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url.endsWith('/export')) return { body: { asset_library: { image_snapshots: [] } } };
    if (url.startsWith('/api/settings/tier-b-status')) return { body: { formal: { capabilities: [{ id: 'sdxl_ip_adapter', family_match: true, chain_ready: false, live_verified: false, reason: 'not_live_verified' }] } } };
    return { status: 500, body: { error: `unexpected ${method} ${url}` } };
  });
  try {
    const result = await f.run('images', ['--chapter-limit', '1']);
    assert.equal(result.code, 1);
    assert.match(result.output, /只提交正式图/);
    assert.equal(calls.some(call => call.includes('/api/assets/generate')), false);
  } finally { await f.close(); }
});

test('full run waits for current image approval before video generation or starting the next chapter', async () => {
  const content = '山风吹过石阶，铜铃仍在掌心。';
  const contentHash = createHash('sha256').update(content).digest('hex');
  const calls = [];
  const script = {
    id: 10, revision: 2, status: 'confirmed', freshness: { sourceChanged: false },
    document: { scenes: [{ id: 'sc-1', blocks: [] }], outline: { beats: [{ id: 'beat-1' }] } },
  };
  const shotFor = (index, name) => ({
    id: 70 + index, chapter_id: `ch-${index}`, index, active_version: 1,
    asset_status: 'completed', asset_url: `/static/shot-${index}.png`,
    shot_spec: { primary_subject: name, source: { type: 'script', script_id: 10, script_revision: 2, script_scene_id: 'sc-1', block_ids: [] } },
  });
  const f = await fixture((url, method, body) => {
    calls.push(`${method} ${url}${body?.scene_id ? ` scene:${body.scene_id}` : ''}${body?.character_id ? ` character:${body.character_id}` : ''}`);
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui', comfyui: { enabled: true } } };
    if (url.includes('/settings/verify')) return { body: { status: 'success' } };
    if (url.includes('/videos/capabilities')) return { body: { video_generation_enabled: true, missing_components: [] } };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, title: '测试', description: '' } };
    if (url.endsWith('/story-plan')) return { body: { revision: 1, document: { blueprint: { characters: [{ name: '阿风' }] } }, entries: [1, 2].map(index => ({ id: `p-${index}`, disposition: 'active', summary: '已有', title: `第${index}章` })) } };
    if (url === '/api/assistant/chat') return { body: { response: '构思' } };
    if (url.startsWith('/api/chapters/?')) return { body: [1, 2].map(index => ({ id: `ch-${index}`, index, title: `第${index}章`, summary: '已有', content, status: 'completed', finalized_content_hash: contentHash, target_word_count: 10 })) };
    if (url === '/api/agent/consistency') return { body: { issues: [] } };
    if (url === '/api/chapters/ch-1/script') return { body: { script } };
    if (url === '/api/scripts/10/export') return { body: { markdown: '剧本' } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [shotFor(1, '阿风')] } };
    if (url === '/api/timeline/ch-2') return { body: { timeline: [shotFor(2, '阿宁')] } };
    if (url === '/api/asset-library/extract') return { body: [] };
    if (url.startsWith('/api/characters/')) return { body: [
      { id: 2, name: '阿风', avatar_url: '/static/a.png', turnaround_url: '/static/t.png', active_version: 1 },
      { id: 3, name: '阿宁' },
    ] };
    if (url.includes('/asset-library')) return { body: [] };
    if (url.endsWith('/export')) return { body: { asset_library: { image_snapshots: [{ scene_id: 71, image_url: '/static/shot-1.png', references_json: '[]', character_versions_json: JSON.stringify([{ id: 2, version: 1 }]) }] } } };
    if (url.endsWith('/asset-references')) return { body: [] };
    if (url.startsWith('/api/settings/tier-b-status')) return { body: { formal: { capabilities: [{ id: 'sdxl_ip_adapter', family_match: true, chain_ready: true, live_verified: true }] } } };
    if (/\/api\/scripts\/\d+\/production\/frames\/\d+$/.test(url.split('?')[0])) return { body: { scene_version: 1, reference_hash: 'a'.repeat(64), available_references: [] } };
    if (url === '/api/assets/generate') {
      assert.equal(body.production_stage, 'production');
      assert.equal(body.workflow.production_guard.redraw, false);
      assert.match(body.workflow.production_guard.reference_hash, /^[a-f0-9]{64}$/);
      return { body: { task_id: 'image-71' } };
    }
    if (url === '/api/assets/status/image-71') return { body: { status: 'completed', image_url: '/static/shot-1.png' } };
    if (url.includes('/media?')) return { body: { assets: [{ id: 82, character_id: 2, role: 'character_reference', status: 'ready' }] } };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    if (url === '/api/videos/generate') return { body: { task_id: `task-${body.scene_id}` } };
    if (url.startsWith('/api/videos/tasks/')) return { body: { status: 'completed', stage: 'completed' } };
    return { status: 500, body: { error: `unexpected ${method} ${url}` } };
  });
  try {
    for (const name of ['shot-1.png', 'a.png', 't.png']) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720', '-frames:v', '1', path.join(f.directory, name)]);
    const result = await f.run('all', ['--chapter-limit', '2', '--accept-legacy-storyboards'], { NOVASTORY_STATIC_DIR: f.directory });
    assert.equal(result.code, 1);
    assert.match(result.output, /images: human approval/);
    assert.equal(calls.some(call => call.includes('/chapters/ch-2/script')), false);
    assert.equal(calls.some(call => call.includes('scene:72') || call.includes('/characters/3/')), false);
    assert.equal(calls.some(call => call.includes('/videos/generate')), false);
  } finally { await f.close(); }
});

test('changing a keyframe creates one new video task while an unchanged resume never duplicates inference', async () => {
  let keyframe = '/static/frame-v1.png';
  const requests = [];
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1' }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 51, chapter_id: 'ch-1', active_version: 1, asset_url: keyframe }] } };
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

test('preflight keeps Codex and Grok off unless the command explicitly requests them', async () => {
  const calls = [];
  let imageSettings = { image_provider: 'codex', comfyui: { enabled: false } };
  const f = await fixture((url) => {
    calls.push(url);
    if (url === '/api/settings/') return { body: imageSettings };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, settings: JSON.stringify({ video_generation: { workflow_id: 'grok_imagine_browser' } }) } };
    if (url.includes('/settings/verify-llm')) return { body: { status: 'success' } };
    if (url.includes('/settings/verify-comfy')) return { body: { status: 'success' } };
    if (url.includes('/videos/capabilities')) return { body: { video_generation_enabled: true, missing_components: [] } };
    if (url.includes('/asset-library')) return { body: [] };
    return { status: 500, body: { error: `unexpected ${url}` } };
  });
  try {
    const blocked = await f.run('preflight', [], { NOVASTORY_VIDEO_WORKFLOW: 'grok_imagine_browser' });
    assert.equal(blocked.code, 1);
    assert.match(blocked.output, /本机 ComfyUI/);
    assert.match(blocked.output, /grok_imagine_browser/);
    assert.equal(calls.some(url => url.includes('/videos/capabilities') && url.includes('grok_imagine_browser')), false);
    calls.length = 0;
    const allowed = await f.run('preflight', ['--allow-codex-image', '--video-workflow', 'grok_imagine_browser'], { NOVASTORY_VIDEO_WORKFLOW: '' });
    assert.equal(allowed.code, 0, allowed.output);
    assert.equal(calls.some(url => url.includes('workflow_id=grok_imagine_browser')), true);
    assert.equal(calls.some(url => url.includes('/settings/verify-comfy')), false);
    imageSettings = { image_provider: 'pony', comfyui: { enabled: true } };
    const ignored = await f.run('preflight', ['--allow-codex-image', '--video-workflow', 'grok_imagine_browser'], { NOVASTORY_VIDEO_WORKFLOW: '' });
    assert.equal(ignored.code, 1);
    assert.match(ignored.output, /当前配置不会走该通路/);
  } finally { await f.close(); }
});

test('rebuild flags regenerate an existing screenplay and storyboard instead of reusing them', async () => {
  const calls = [];
  const script = {
    id: 10, revision: 4, status: 'confirmed', freshness: { sourceChanged: false },
    document: { scenes: [{ id: 'sc-1', blocks: [{ id: 'b-1' }] }], outline: { beats: [{ id: 'beat-1' }] } },
  };
  const outlineCandidate = { id: 'outline-1', state: 'pending', base_revision: 4, candidate_revision: 5, after_json: JSON.stringify({ beats: [{ id: 'beat-1' }] }) };
  const scriptCandidate = { id: 'script-1', state: 'pending', base_revision: 5, candidate_revision: 6, after_json: JSON.stringify({ scenes: [{ id: 'sc-1' }] }) };
  const f = await fixture((url, method) => {
    calls.push(`${method} ${url}`);
    if (url === '/api/projects/90713823') return { body: { settings: {} } };
    if (url === '/api/settings/') return { body: {} };
    if (url === '/api/chapters/?project_id=90713823') return { body: [{ id: 'ch-1', index: 1 }] };
    if (url === '/api/chapters/ch-1/script' && method === 'POST') return { body: { script } };
    if (url === '/api/chapters/ch-1/script' && method === 'GET') return { body: { script } };
    if (url === '/api/scripts/10/export') return { body: { markdown: '剧本' } };
    if (url === '/api/scripts/10/candidates' && method === 'POST') {
      const kind = calls.filter(call => call === 'POST /api/scripts/10/candidates').length;
      return { body: { candidate: kind === 1 ? outlineCandidate : scriptCandidate } };
    }
    if (url.includes('/candidates/') && url.endsWith('/apply')) return { body: { script: { ...script, revision: url.includes('outline') ? 5 : 6, status: 'draft' } } };
    if (url === '/api/scripts/10/confirm') return { body: { script: { ...script, revision: 7, status: 'confirmed' } } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 202, active_version: 1, shot_spec: { source: { type: 'script', script_id: 10, script_revision: 4 } } }] } };
    if (url.includes('/media')) return { body: { assets: [] } };
    if (url.includes('/storyboard-candidates')) return { body: { candidate: { id: 'board-1', state: 'pending', base_revision: 4, candidate_revision: 5 } } };
    return { status: 500, body: { error: `unexpected ${method} ${url}` } };
  });
  try {
    const kept = await f.run('scripts');
    assert.equal(kept.code, 0, kept.output);
    assert.equal(calls.some(call => call.includes('/candidates')), false);
    const legacyBoard = await f.run('storyboards');
    assert.equal(legacyBoard.code, 1, legacyBoard.output);
    assert.match(legacyBoard.output, /policy is unknown/);
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')).storyboardInputs?.['ch-1'], undefined);
    const acceptedLegacyBoard = await f.run('storyboards', ['--accept-legacy-storyboards']);
    assert.equal(acceptedLegacyBoard.code, 0, acceptedLegacyBoard.output);
    assert.match(acceptedLegacyBoard.output, /policy remains unknown/);
    assert.equal(JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8')).storyboardInputs?.['ch-1'], undefined);
    calls.length = 0;
    const rebuilt = await f.run('scripts', ['--rebuild-scripts']);
    assert.equal(rebuilt.code, 0, rebuilt.output);
    assert.equal(calls.filter(call => call === 'POST /api/scripts/10/candidates').length, 2);
    calls.length = 0;
    const board = await f.run('storyboards', ['--rebuild-storyboards']);
    assert.equal(board.code, 0, board.output);
    assert.equal(calls.some(call => call.startsWith('POST') && call.includes('/storyboard-candidates')), true);
    assert.equal(calls.some(call => call.includes('/storyboard-candidates/') && call.includes('/apply')), true);
  } finally { await f.close(); }
});

test('--reproduce-from-b3 archives B3..D artifacts into history while preserving A..B2 and archives ready final videos', async () => {
  const calls = [];
  let applyPayload = null;
  const script = {
    id: 10, revision: 4, status: 'confirmed', freshness: { sourceChanged: false },
    document: { scenes: [{ id: 'sc-1', blocks: [{ id: 'b-1' }] }], outline: { beats: [{ id: 'beat-1' }] } },
  };
  const f = await fixture((url, method, body) => {
    calls.push(`${method} ${url}`);
    if (url === '/api/projects/90713823') return { body: { settings: {} } };
    if (url === '/api/settings/') return { body: { llm: { provider: 'ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'novastory-qwen3.5:9b' } } };
    if (url === '/api/chapters/?project_id=90713823') return { body: [{ id: 'ch-1', index: 1 }] };
    if (url === '/api/chapters/ch-1/script') return { body: { script } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 202, active_version: 1, shot_spec: { source: { type: 'script', script_id: 10, script_revision: 4 } } }] } };
    if (url.includes('/media')) return { body: { assets: [{ id: 501, role: 'narrative_final', status: 'ready' }] } };
    if (url === '/api/videos/assets/501/archive' && method === 'POST') return { body: { id: 501, status: 'archived' } };
    if (url === '/api/scripts/10/storyboard-candidates' && method === 'POST') return { body: { candidate: { id: 'board-repro', state: 'pending', base_revision: 4, candidate_revision: 5 } } };
    if (url === '/api/scripts/10/storyboard-candidates/board-repro/apply' && method === 'POST') {
      applyPayload = body;
      return { body: { success: true, count: 1, scene_ids: [203] } };
    }
    return { status: 500, body: { error: `unexpected ${method} ${url}` } };
  });
  try {
    await writeFile(path.join(f.directory, '01-brainstorm.txt'), '构思保留');
    await writeFile(path.join(f.directory, '02-story-plan.json'), '{"keep":true}');
    await writeFile(path.join(f.directory, '03-chapter-1.txt'), '正文保留');
    await writeFile(path.join(f.directory, '04-continuity-review.json'), '{"old":true}');
    await writeFile(path.join(f.directory, '05-script-1.json'), '{"old":true}');
    await writeFile(path.join(f.directory, 'state.json'), JSON.stringify({
      projectId: 90713823,
      steps: {
        brainstorm: { status: 'completed', result: { response: '构思' } },
        'chapter-1:draft': { status: 'completed', result: {} },
        'storyboard-10:revision-4:policy-old:candidate': { status: 'completed', result: {} },
      },
      reviews: { images: { 'ch-1': { status: 'approved' } } },
    }));
    const res = await f.run('storyboards', ['--chapter-limit', '1', '--reproduce-from-b3']);
    assert.equal(res.code, 0, res.output);
    assert.equal(await readFile(path.join(f.directory, '01-brainstorm.txt'), 'utf8'), '构思保留');
    assert.equal(await readFile(path.join(f.directory, '03-chapter-1.txt'), 'utf8'), '正文保留');
    assert.equal(calls.includes('POST /api/videos/assets/501/archive'), true);
    assert.equal(applyPayload?.replace_existing, true);
    assert.equal(applyPayload?.archive_continuity, true);
    const nextState = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
    assert.equal(nextState.steps.brainstorm?.status, 'completed');
    assert.equal(nextState.steps['storyboard-10:revision-4:policy-old:candidate'], undefined);
    assert.equal(nextState.reviews, undefined);
    assert.equal(nextState.historyArchives?.length, 1);
    assert.equal(nextState.historyArchives[0].entries.includes('04-continuity-review.json'), true);
    assert.equal(nextState.historyArchives[0].entries.includes('05-script-1.json'), true);
    await writeFile(path.join(f.directory, '05-script-1.json'), '{"resume":true}');
    nextState.steps['storyboard-resume:in-progress'] = { status: 'in_progress', result: {} };
    await writeFile(path.join(f.directory, 'state.json'), JSON.stringify(nextState));
    const resumed = await f.run('storyboards', ['--chapter-limit', '1', '--reproduce-from-b3']);
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(await readFile(path.join(f.directory, '05-script-1.json'), 'utf8'), '{"resume":true}');
    const resumedState = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
    assert.equal(resumedState.historyArchives.length, 1);
    assert.equal(resumedState.steps['storyboard-resume:in-progress']?.status, 'in_progress');
    assert.equal(resumedState.reproduction.id, 'b3:90713823');
  } finally { await f.close(); }
});

test('preflight blocks built-in codex, supports --llm-mode local and --llm-mode remote in parallel, and videoPreflight auto-binds continuity shots', async () => {
  const calls = [];
  let preflightCalls = 0;
  let llmSettings = { provider: 'openai', base_url: 'https://comfy.chuangyi.chat/gemma4/v1', model: 'gemma-4-31b' };
  const f = await fixture((url, method, body) => {
    calls.push(`${method} ${url}`);
    if (url === '/api/settings/' && method === 'POST') {
      llmSettings = { ...llmSettings, ...body.llm, model: body.llm_model || body.llm?.model };
      return { body: { llm: llmSettings } };
    }
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui', comfyui: { enabled: true }, llm: llmSettings } };
    if (url === '/api/projects/90713823') return { body: { id: 90713823, settings: '{}' } };
    if (url.includes('/settings/verify-llm')) return { body: { status: 'success' } };
    if (url.includes('/settings/verify-comfy')) return { body: { status: 'success' } };
    if (url.includes('/videos/capabilities')) return { body: { video_generation_enabled: true, missing_components: [] } };
    if (url.includes('/asset-library')) return { body: [] };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1', index: 1 }] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ id: 88, chapter_id: 'ch-1', active_version: 1, asset_status: 'completed', asset_url: '/static/88.png', shot_spec: { source: { type: 'script', script_id: 10, script_revision: 1, script_scene_id: 'sc-1' } } }] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url === '/api/videos/preflight') {
      preflightCalls++;
      return { body: preflightCalls === 1 ? { ready: false, blockers: ['Continuity gate: Bind this shot version to a confirmed continuity moment before video generation'] } : { ready: true, blockers: [] } };
    }
    if (url === '/api/scripts/10/continuity/bind-chapter-shots' && method === 'POST') return { body: { script_id: 10, bound_scene_ids: [88] } };
    return { status: 500, body: { error: `unexpected ${method} ${url}` } };
  });
  try {
    const quietMode = { NOVASTORY_LLM_MODE: '', LLM_MODE: '' };
    const blockedUnrequestedRemote = await f.run('preflight', [], quietMode);
    assert.equal(blockedUnrequestedRemote.code, 1);
    assert.match(blockedUnrequestedRemote.output, /--llm-mode remote/);
    const okRemotePreset = await f.run('preflight', ['--llm-mode', 'remote'], { ...quietMode, NOVASTORY_BUILTIN_AI: '' });
    assert.equal(okRemotePreset.code, 0, okRemotePreset.output);
    llmSettings = { provider: 'ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'novastory-qwen3.5:9b' };
    const appliedRemote = await f.run('preflight', ['--llm-mode', 'remote'], { ...quietMode, NOVASTORY_BUILTIN_AI: '' });
    assert.equal(appliedRemote.code, 0, appliedRemote.output);
    assert.equal(llmSettings.provider, 'openai');
    assert.equal(llmSettings.model, 'gemma-4-31b');
    assert.equal(llmSettings.base_url, 'https://comfy.chuangyi.chat/gemma4/v1');
    llmSettings = { provider: 'ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'novastory-qwen3.5:9b' };
    const blockedBuiltinEnv = await f.run('preflight', [], { ...quietMode, NOVASTORY_BUILTIN_AI: 'codex' });
    assert.equal(blockedBuiltinEnv.code, 1);
    assert.match(blockedBuiltinEnv.output, /禁止通过 NOVASTORY_BUILTIN_AI=codex/);
    const okLocalPreflight = await f.run('preflight', [], { ...quietMode, NOVASTORY_BUILTIN_AI: '' });
    assert.equal(okLocalPreflight.code, 0, okLocalPreflight.output);
    const okVideoPreflight = await f.run('video-preflight', ['--chapter-limit', '1']);
    assert.equal(okVideoPreflight.code, 0, okVideoPreflight.output);
    assert.equal(calls.includes('POST /api/scripts/10/continuity/bind-chapter-shots'), true);
    assert.equal(preflightCalls, 2);
  } finally { await f.close(); }
});
