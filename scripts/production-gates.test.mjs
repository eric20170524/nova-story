import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fingerprint } from './production-contracts.mjs';

async function fixture({ shared = false, issues = [], imageSettings = { nsfw_mode: 'off' } } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-adversarial-20261007-'));
  const staticRoot = path.join(folder, 'static'); fs.mkdirSync(staticRoot);
  const output = path.join(folder, 'production');
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const content = '同一山谷，两章不同时间的环境镜头。'.repeat(5);
  const chapters = [1, 2].map(index => ({ id: `chapter-${index}`, index, title: `第${index}章`, content, status: 'completed', target_word_count: 10, finalized_content_hash: createHash('sha256').update(content).digest('hex') }));
  const scripts = [1, 2].map(index => ({ id: index, revision: 2, status: 'confirmed', freshness: { sourceChanged: false }, document: { outline: { beats: [{ id: 'beat' }] }, scenes: [{ id: `scene-${index}`, blocks: [{ id: `action-${index}`, type: 'action', text: '风吹过空山谷' }] }] } }));
  const shots = [1, 2].map(index => ({ id: index, chapter_id: `chapter-${index}`, index: 1, active_version: 1, duration: 5, asset_status: 'completed', asset_url: `/static/frame-${index}.png`, narration: '', dialogue: '', audio_prompt: '', shot_spec: { primary_subject: '山谷', location: shared ? '山谷' : '', key_props: [], source: { type: 'script', script_id: index, script_revision: 2, script_scene_id: `scene-${index}`, block_ids: [`action-${index}`] } } }));
  const settings = { image_provider: 'comfyui', comfyui: { enabled: true } };
  const project = { id: 99002, title: '隔离对抗测试', settings: { image_generation: imageSettings } };
  const library = shared ? [{ id: 7, project_id: 99002, kind: 'location', name: '山谷', description: '空山谷', visual_prompt: 'empty valley', revision: 1, status: 'completed', image_url: '/static/frame-1.png', task_id: null, source_chapter_ids: JSON.stringify(['chapter-1']) }] : [];
  const media = [1, 2].map(index => [{ id: 100 + index, role: 'video_keyframe', status: 'ready', media_type: 'image', url: `/static/frame-${index}.png` }]);
  const events = [];
  const inputSignature = body => fingerprint({ id: body.scene_id, preset: body.preset, settings: project.settings, shot: shots[body.scene_id - 1], keyframe: hash(path.join(staticRoot, `frame-${body.scene_id}.png`)) });
  const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
  for (const index of [1, 2]) {
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${index === 1 ? 'blue' : 'green'}:s=1280x720`, '-frames:v', '1', path.join(staticRoot, `frame-${index}.png`)]);
    const videoDir = path.join(staticRoot, `video-${index}`); fs.mkdirSync(videoDir);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${index === 1 ? 'blue' : 'green'}:s=1280x720:r=24`, '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '5', '-frames:v', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(videoDir, 'final.mp4')]);
  }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    let result;
    try {
      const url = req.url;
      if (url === '/api/settings/') result = settings;
      else if (url.includes('/settings/verify')) result = { status: 'success' };
      else if (url.startsWith('/api/videos/capabilities')) result = { video_generation_enabled: true, missing_components: [] };
      else if (url === '/api/projects/99002') result = project;
      else if (url.endsWith('/story-plan')) result = { revision: 1, document: { blueprint: { characters: [] } }, entries: chapters.map(chapter => ({ id: chapter.id, disposition: 'active', summary: '已有规划' })) };
      else if (url === '/api/assistant/chat') result = { response: '已有构思' };
      else if (url.startsWith('/api/chapters/?')) result = chapters;
      else if (/\/chapters\/chapter-[12]\/script$/.test(url)) result = { script: scripts[Number(url.match(/chapter-(\d)/)[1]) - 1] };
      else if (/\/scripts\/[12]\/export$/.test(url)) result = { markdown: '隔离剧本' };
      else if (/\/timeline\/chapter-[12]$/.test(url)) result = { timeline: [shots[Number(url.match(/chapter-(\d)/)[1]) - 1]] };
      else if (url.endsWith('/asset-references')) result = library.map(asset => ({ ...asset, asset_revision: asset.revision, stale: 0 }));
      else if (url.includes('/media?')) result = { assets: media[Number(url.match(/scenes\/(\d+)/)[1]) - 1] };
      else if (url.startsWith('/api/characters/')) result = [];
      else if (url === '/api/asset-library/extract') {
        if (shared) library[0].source_chapter_ids = JSON.stringify([...new Set([...JSON.parse(library[0].source_chapter_ids), body.chapter_id])]);
        result = library;
      }
      else if (url.includes('/asset-library')) result = library;
      else if (url.endsWith('/export')) result = { asset_library: { image_snapshots: shots.map(shot => ({ scene_id: shot.id, image_url: shot.asset_url, references_json: JSON.stringify(library.map(asset => ({ id: asset.id, revision: asset.revision }))), character_versions_json: '[]' })) } };
      else if (url === '/api/agent/consistency') { events.push('consistency'); result = { issues }; }
      else if (url === '/api/assets/generate') { events.push(`image-${body.scene_id}`); result = { task_id: `image-${body.scene_id}` }; }
      else if (url.startsWith('/api/assets/status/')) result = { status: 'completed', image_url: `/static/frame-${Number(url.match(/image-(\d+)/)[1])}.png` };
      else if (url === '/api/videos/preflight') result = { ready: true, blockers: [], input_signature: inputSignature(body) };
      else if (url === '/api/videos/generate') {
        events.push(`video-${body.scene_id}`);
        const index = body.scene_id;
        media[index - 1].push({ id: 200 + index, role: 'narrative_final', media_type: 'video', status: 'draft', url: `/static/video-${index}/final.mp4`, sha256: hash(path.join(staticRoot, `video-${index}`, 'final.mp4')) });
        fs.writeFileSync(path.join(staticRoot, `video-${index}`, 'manifest.json'), JSON.stringify({ metadata: { request: { ...body, keyframe_asset_id: 100 + index, input_signature: inputSignature(body) } } }));
        result = { task_id: `video-${index}` };
      } else if (url.startsWith('/api/videos/tasks/')) result = { status: 'completed', stage: 'completed' };
      else throw new Error(`Unexpected ${req.method} ${url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const run = async (stage = 'all', extra = []) => {
    const child = spawn(process.execPath, ['scripts/full-production.mjs', '--project', '99002', '--chapter-limit', '2', '--stage', stage, '--base-url', `http://127.0.0.1:${server.address().port}`, '--output', output, '--accept-legacy-storyboards', ...extra], { env: { ...process.env, NOVASTORY_STATIC_DIR: staticRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); return { code, log };
  };
  const read = name => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
  const approve = async (kind, index) => {
    const preview = read(`${kind}-chapter-chapter-${index}.json`);
    const result = await run(kind, ['--chapter-id', `chapter-${index}`, '--reviewer', '隔离测试审核人', '--review-fingerprint', preview.fingerprint]);
    assert.equal(result.code, 0, result.log); events.push(`approved-${kind}-${index}`);
  };
  const completeChapter = async index => {
    let result = await run(); assert.equal(result.code, 1, result.log); assert.match(result.log, new RegExp(`Chapter ${index} images: human approval`));
    await approve('review-images', index);
    result = await run(); assert.equal(result.code, 1, result.log); assert.match(result.log, /visual review/);
    media[index - 1].at(-1).status = 'ready';
    result = await run(); assert.equal(result.code, 1, result.log); assert.match(result.log, /chapter_ready: human approval/);
    await approve('review-chapter', index);
  };
  return { run, read, write: (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value)), approve, completeChapter, events, library, writeState: value => fs.writeFileSync(path.join(output, 'state.json'), JSON.stringify(value)), async close() {
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(folder);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('nova-adversarial-20261007-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  } };
}

test('shared asset reuse preserves an earlier image and chapter approval', { timeout: 180000 }, async () => {
  const f = await fixture({ shared: true });
  try {
    await f.completeChapter(1);
    const before = f.read('review-images-chapter-chapter-1.json');
    const chapterPreview = f.read('review-chapter-chapter-chapter-1.json');
    const legacyReference = { ...f.library[0], asset_revision: f.library[0].revision, stale: 0 };
    before.snapshot.frames[0].references = [legacyReference];
    before.fingerprint = fingerprint(before.snapshot);
    chapterPreview.snapshot.source.frames[0].references = [legacyReference];
    chapterPreview.snapshot.delivery.source_fingerprint = fingerprint(chapterPreview.snapshot.source);
    chapterPreview.fingerprint = fingerprint(chapterPreview.snapshot);
    const manifest = f.read('videos/chapter-1.manifest.json');
    manifest.source_fingerprint = chapterPreview.snapshot.delivery.source_fingerprint;
    const state = f.read('state.json');
    state.reviews.images['chapter-1'].fingerprint = before.fingerprint;
    state.reviews.chapters['chapter-1'].fingerprint = chapterPreview.fingerprint;
    f.write('review-images-chapter-chapter-1.json', before);
    f.write('review-chapter-chapter-chapter-1.json', chapterPreview);
    f.write('videos/chapter-1.manifest.json', manifest);
    f.writeState(state);
    const expectedFingerprint = fingerprint({ ...before.snapshot, frames: before.snapshot.frames.map(frame => ({ ...frame, references: frame.references.map(ref => ({ id: ref.id, revision: ref.asset_revision, image_url: ref.image_url })) })) });
    const next = await f.run(); assert.match(next.log, /Chapter 2 images: human approval/);
    assert.equal(f.library[0].revision, 1);
    assert.deepEqual(JSON.parse(f.library[0].source_chapter_ids), ['chapter-1', 'chapter-2']);
    const resumed = await f.run(); assert.match(resumed.log, /Chapter 2 images: human approval/);
    const after = f.read('review-images-chapter-chapter-1.json');
    assert.equal(expectedFingerprint, after.fingerprint);
    assert.equal(before.snapshot.frames[0].image.sha256, after.snapshot.frames[0].image.sha256);
    assert.deepEqual(before.snapshot.assets, after.snapshot.assets);
  } finally { await f.close(); }
});

test('chapter two image submission waits for current chapter one acceptance', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const early = await f.run('images', ['--chapter-id', 'chapter-2']); assert.equal(early.code, 1, early.log);
    assert.match(early.log, /Chapter 1 images/);
    assert.deepEqual(f.events, []);
    assert.equal(f.read('state.json').reviews, undefined);
    await f.completeChapter(1); await f.completeChapter(2);
    const final = await f.run(); assert.equal(final.code, 0, final.log);
    const acceptance = f.read('acceptance.json').acceptance;
    assert.ok(acceptance.every(item => item.status === 'PASS'), JSON.stringify(acceptance));
    const state = f.read('state.json');
    assert.ok(state.taskSubmissions.some(event => event.chapter_id === 'chapter-2'));
    state.taskSubmissions.push({ chapter_id: 'chapter-2', kind: 'image', submission_step: 'historical-early-submit', submitted_at: new Date(0).toISOString() });
    f.writeState(state);
    const rejected = await f.run('verify'); assert.equal(rejected.code, 1, rejected.log);
    assert.equal(f.read('acceptance.json').acceptance.find(item => item.id === 'F16').status, 'FAIL');
    delete state.taskSubmissions;
    f.writeState(state);
    const legacy = await f.run('verify'); assert.equal(legacy.code, 1, legacy.log);
    assert.equal(f.read('acceptance.json').acceptance.find(item => item.id === 'F16').status, 'FAIL');
    const order = f.read('legacy-task-order.json');
    assert.ok(order.snapshot.untracked.length > 0);
    const reviewed = await f.run('review-task-order', ['--reviewer', '隔离测试审核人', '--review-fingerprint', order.fingerprint, '--review-note', '逐项核对旧任务时间和前章签字']);
    assert.equal(reviewed.code, 0, reviewed.log);
    const migrated = await f.run('verify'); assert.equal(migrated.code, 0, migrated.log);
    assert.equal(f.read('acceptance.json').acceptance.find(item => item.id === 'F16').status, 'PASS');
  } finally { await f.close(); }
});

test('continuity issues require a recorded disposition before image production', { timeout: 60000 }, async () => {
  const issues = [{ severity: 'critical', description: '第一章已死亡的主角在第二章无解释复活', location: '第二章' }];
  const f = await fixture({ issues });
  try {
    const result = await f.run(); assert.match(result.log, /Continuity issues need disposition/);
    assert.deepEqual(f.read('04-continuity-review.json').issues, issues);
    assert.deepEqual(f.events, ['consistency']);
    const fingerprint = f.read('04-continuity-review.json').review_fingerprint;
    assert.ok(fingerprint);
    const reviewed = await f.run('review-continuity', ['--reviewer', '隔离测试审核人', '--review-fingerprint', fingerprint, '--review-note', '已核对并说明复活情节']);
    assert.equal(reviewed.code, 0, reviewed.log);
    const resumed = await f.run(); assert.match(resumed.log, /Chapter 1 images: human approval/);
    assert.ok(f.events.includes('image-1'));
  } finally { await f.close(); }
});

test('SD1.5 project fails preflight before image generation', { timeout: 60000 }, async () => {
  const code = `const { resolveImageOutputTarget } = require('./backend/src/services/image_output_spec.ts');
    console.log(JSON.stringify(['draft','standard','high'].map(resolution => {
      const target = resolveImageOutputTarget({modelFamily:'sd15', workflowData:{gen_type:'scene', project_settings:{image_generation:{output_spec:{aspect_ratio:'16:9',resolution,orientation_policy:'fixed'}}}}});
      return {resolution,width:target.width,height:target.height};
    })));`;
  const sizes = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { encoding: 'utf8' }));
  assert.ok(sizes.every(size => size.width < 1280 && size.height < 720));
  const f = await fixture({ imageSettings: { model: 'sd15', output_spec: { aspect_ratio: '16:9', resolution: 'high', orientation_policy: 'fixed' } } });
  try {
    const result = await f.run('preflight'); assert.equal(result.code, 1, result.log);
    assert.match(result.log, /1280×720/);
    assert.deepEqual(f.events, []);
  } finally { await f.close(); }
});
