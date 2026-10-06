// Historical defect audit: a passing assertion below confirms a limitation,
// rather than proving that a production video has passed acceptance.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertChapterClipReady } from '../../scripts/video-delivery-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = path.join(root, 'local/verification');
const evidence = { checkedAt: new Date().toISOString(), purpose: 'current defects and manual 720p assembly audit, without model inference', checks: [] };
after(() => writeFile(path.join(evidenceRoot, 'production-chain-audit.json'), JSON.stringify(evidence, null, 2)));
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  return { code, output };
}
async function fixture(handler) {
  const directory = await mkdtemp(path.join(evidenceRoot, 'chain-audit-'));
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
      const result = await handler(req.url, req.method, raw ? JSON.parse(raw) : undefined);
      res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    directory,
    run: (stage, extra = []) => run(process.execPath, ['scripts/full-production.mjs', '--project', '90713823', '--stage', stage, '--chapter-limit', '1', '--base-url', `http://127.0.0.1:${server.address().port}`, '--output', directory, ...extra], { env: { ...process.env, NOVASTORY_STATIC_DIR: directory } }),
    async close() {
      await new Promise(resolve => server.close(resolve));
      const target = path.resolve(directory);
      assert.ok(target.startsWith(`${path.resolve(evidenceRoot)}${path.sep}chain-audit-`));
      await rm(target, { recursive: true, force: true });
    },
  };
}
const shot = { id: 51, chapter_id: 'ch-1', index: 1, active_version: 1, asset_status: 'completed', asset_url: '/static/frame.png' };
const validProbe = (width = 1280, height = 720) => ({ streams: [{ codec_type: 'video', width, height, r_frame_rate: '24/1', nb_frames: '120' }], format: { duration: '5' } });

test('the production driver checks 720p but submits a 480p request', async () => {
  const requests = [];
  const f = await fixture((url, method, body) => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1', index: 1 }] };
    if (url === '/api/projects/90713823') return { body: { settings: '{}' } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [shot] } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url === '/api/videos/preflight') { requests.push({ endpoint: 'preflight', preset: body.preset }); return { body: { ready: true, blockers: [] } }; }
    if (url === '/api/videos/generate') { requests.push({ endpoint: 'generate', preset: body.preset }); return { body: { task_id: 'mock-task' } }; }
    if (url === '/api/videos/tasks/mock-task') return { body: { status: 'completed', stage: 'completed' } };
    return { status: 500, body: { error: `unexpected ${url}` } };
  });
  try {
    assert.equal((await f.run('video-preflight')).code, 0);
    const generated = await f.run('videos');
    assert.match(generated.output, /visual review/);
    assert.deepEqual(requests.map(item => item.preset), ['standard_720p_5s', 'preview_480p_5s', 'preview_480p_5s']);
    assert.throws(() => assertChapterClipReady(validProbe(864, 480), 'preview'), /resolution 864x480/);
    evidence.checks.push({ id: 'preset_mismatch', reproduced: true, requests });
  } finally { await f.close(); }
});

test('a new project without a plan stops before brainstorming or bootstrap', async () => {
  const calls = [];
  const f = await fixture(url => {
    calls.push(url);
    if (url === '/api/projects/90713823') return { body: { title: 'New project' } };
    if (url.endsWith('/story-plan')) return { status: 404, body: { code: 'PLAN_NOT_FOUND' } };
    return { status: 500, body: {} };
  });
  try {
    const result = await f.run('text');
    assert.equal(result.code, 1);
    assert.match(result.output, /PLAN_NOT_FOUND/);
    assert.equal(calls.some(url => url.endsWith('/bootstrap')), false);
    evidence.checks.push({ id: 'missing_bootstrap', reproduced: true, calls });
  } finally { await f.close(); }
});

test('an obsolete failed scene in a saved preflight blocks the new current scene', async () => {
  const content = 'A completed chapter.';
  const source = { type: 'script', script_id: 10, script_revision: 2, script_scene_id: 'sc-1', block_ids: [] };
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/?')) return { body: [{ id: 'ch-1', index: 1, content, status: 'completed', target_word_count: 10, finalized_content_hash: createHash('sha256').update(content).digest('hex') }] };
    if (url === '/api/projects/90713823') return { body: { title: 'Test', settings: '{}' } };
    if (url.endsWith('/story-plan')) return { body: { revision: 1, document: { blueprint: { characters: [] } }, entries: [{ id: 'p-1', disposition: 'active', summary: 'Plan' }] } };
    if (url === '/api/settings/') return { body: { image_provider: 'comfyui', comfyui: { enabled: true } } };
    if (url.includes('/settings/verify')) return { body: { status: 'success' } };
    if (url.includes('/videos/capabilities')) return { body: { video_generation_enabled: true, missing_components: [] } };
    if (url === '/api/assistant/chat') return { body: { response: 'Idea' } };
    if (url === '/api/agent/consistency') return { body: { issues: [] } };
    if (url.endsWith('/script')) return { body: { script: { id: 10, revision: 2, status: 'confirmed', freshness: { sourceChanged: false }, document: { scenes: [{ id: 'sc-1', blocks: [] }] } } } };
    if (url === '/api/scripts/10/export') return { body: { markdown: 'Script' } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [{ ...shot, shot_spec: { source } }] } };
    if (url.includes('/asset-library') || url.endsWith('/asset-references')) return { body: [] };
    if (url.endsWith('/export')) return { body: { asset_library: { image_snapshots: [{ scene_id: 51, image_url: shot.asset_url, references_json: '[]', character_versions_json: '[]' }] } } };
    if (url.includes('/media?')) return { body: { assets: [] } };
    if (url.startsWith('/api/characters/')) return { body: [] };
    if (url === '/api/videos/preflight') return { body: { ready: true, blockers: [] } };
    return { status: 500, body: {} };
  });
  try {
    await writeFile(path.join(f.directory, '09-video-preflight.json'), JSON.stringify({ results: [{ scene_id: 50, chapter_id: 'ch-1', ready: false, keyframe_ready: false }] }));
    const result = await f.run('all');
    assert.equal(result.code, 1);
    const saved = JSON.parse(await readFile(path.join(f.directory, '09-video-preflight.json'), 'utf8'));
    assert.equal(saved.results.find(item => item.scene_id === 51).ready, true);
    assert.equal(saved.results.find(item => item.scene_id === 50).ready, false);
    evidence.checks.push({ id: 'obsolete_preflight', reproduced: true, sceneIds: saved.results.map(item => item.scene_id) });
  } finally { await f.close(); }
});

test('F15 permits omitted audible blocks, while F13 rejects an otherwise current environment video', async () => {
  const currentShot = { ...shot, shot_spec: { primary_subject: 'mountains', source: { type: 'script', script_id: 10, script_revision: 2, script_scene_id: 'sc-1', block_ids: [] } } };
  const screenplay = { id: 10, revision: 2, status: 'confirmed', freshness: { sourceChanged: false }, document: { scenes: [{ id: 'sc-1', blocks: [{ id: 'b-dialogue', type: 'dialogue', text: 'Source dialogue' }] }, { id: 'sc-2', blocks: [{ id: 'b-voiceover', type: 'voiceover', text: 'Source voiceover' }] }] } };
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/?')) return { body: [{ id: 'ch-1', index: 1, target_word_count: 1600 }] };
    if (url.endsWith('/story-plan')) return { body: { document: { blueprint: { characters: [] } }, entries: [] } };
    if (url.startsWith('/api/characters/') || url.includes('/asset-library') || url.endsWith('/asset-references')) return { body: [] };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [currentShot] } };
    if (url.endsWith('/script')) return { body: { script: screenplay } };
    if (url.endsWith('/export')) return { body: {} };
    if (url.includes('/media?')) return { body: { assets: [{ id: 90, role: 'narrative_final', status: 'ready', url: '/static/task/final.mp4' }, { id: 83, role: 'video_keyframe', status: 'ready', url: shot.asset_url }] } };
    return { status: 500, body: {} };
  });
  try {
    await mkdir(path.join(f.directory, 'task'));
    await writeFile(path.join(f.directory, 'task/final.mp4'), '');
    await writeFile(path.join(f.directory, 'task/manifest.json'), JSON.stringify({ metadata: { request: { scene_id: 51, scene_version: 1, keyframe_asset_id: 83, character_reference_asset_ids: [] } } }));
    assert.equal((await f.run('verify')).code, 1);
    const acceptance = JSON.parse(await readFile(path.join(f.directory, 'acceptance.json'), 'utf8')).acceptance;
    assert.equal(acceptance.find(item => item.id === 'F15').status, 'PASS');
    assert.equal(acceptance.find(item => item.id === 'F13').status, 'FAIL');
    const quality = JSON.parse(await readFile(path.join(f.directory, 'media-quality.json'), 'utf8'));
    assert.equal(quality.identities[0].identity_current, true);
    assert.equal(acceptance.find(item => item.id === 'F14').status, 'PASS');
    evidence.checks.push({ id: 'acceptance_limits', reproduced: true, omittedAudibleBlocks: 2, omittedScriptScenes: 1, F15: 'PASS', environmentIdentityCurrent: true, F13: 'FAIL' });
  } finally { await f.close(); }
});

test('the delivery gate accepts missing frame counts and hence does not prove 120 frames', () => {
  const info = validProbe(); delete info.streams[0].nb_frames;
  assert.doesNotThrow(() => assertChapterClipReady(info, 'unknown frames'));
  evidence.checks.push({ id: 'unknown_frame_count', reproduced: true });
});

test('real synthetic 480p files fail assembly while manually supplied 720p files concatenate', async () => {
  const f = await fixture(url => {
    if (url.startsWith('/api/chapters/')) return { body: [{ id: 'ch-1', index: 1 }] };
    if (url.startsWith('/api/characters/') || url.includes('/asset-library') || url.endsWith('/asset-references')) return { body: [] };
    if (url.endsWith('/export')) return { body: { asset_library: { image_snapshots: [{ scene_id: 51, image_url: shot.asset_url, references_json: '[]', character_versions_json: '[]' }] } } };
    if (url === '/api/timeline/ch-1') return { body: { timeline: [shot] } };
    if (url.includes('/media?')) return { body: { assets: [{ id: 90, role: 'narrative_final', status: 'ready', url: '/static/task/final.mp4' }, { id: 83, role: 'video_keyframe', status: 'ready', url: shot.asset_url }] } };
    return { status: 500, body: {} };
  });
  try {
    await mkdir(path.join(f.directory, 'task'));
    await writeFile(path.join(f.directory, 'task/manifest.json'), JSON.stringify({ metadata: { request: { scene_id: 51, scene_version: 1, keyframe_asset_id: 83, character_reference_asset_ids: [] } } }));
    const file = path.join(f.directory, 'task/final.mp4');
    const make = size => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=24:d=5`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    assert.equal((await make('864x480')).code, 0);
    const blocked = await f.run('assemble');
    assert.equal(blocked.code, 1);
    assert.match(blocked.output, /resolution 864x480, expected 1280x720/);
    assert.equal((await make('1280x720')).code, 0);
    const assembled = await f.run('assemble');
    assert.equal(assembled.code, 0, assembled.output);
    const delivery = JSON.parse(await readFile(path.join(f.directory, '10-video-delivery.json'), 'utf8'));
    assertChapterClipReady(delivery.final.probe, 'synthetic final', { requireAudio: true });
    evidence.checks.push({ id: 'synthetic_assembly', previewBlocked: true, manual720pPassed: true, chapterCount: delivery.chapters.length, finalProbe: delivery.final.probe, limitation: 'one synthetic silent shot, not model production or a content-quality acceptance' });
  } finally { await f.close(); }
});
