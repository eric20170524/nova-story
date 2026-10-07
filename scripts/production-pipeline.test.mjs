import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fingerprint } from './production-contracts.mjs';

test('two chapters resume through image/video/chapter approvals and deliver full speech, subtitles and current provenance', { timeout: 180000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-production-chain-'));
  const staticRoot = path.join(folder, 'static'); fs.mkdirSync(staticRoot);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const text = '这是一段必须完整保留、不能在五秒时被截断的旁白。'.repeat(5);
  const content = '山风吹过石阶，远处钟声传来。'.repeat(5);
  const contentHash = createHash('sha256').update(content).digest('hex');
  const chapters = [1, 2].map(index => ({ id: `chapter-${index}`, index, title: `第${index}章`, content, status: 'completed', target_word_count: 10, finalized_content_hash: contentHash }));
  const scripts = [1, 2].map(index => ({ id: index, revision: 2, status: 'confirmed', freshness: { sourceChanged: false }, document: { outline: { beats: [{ id: 'beat' }] }, scenes: [{ id: `scene-${index}`, blocks: index === 1 ? [{ id: 'voice', type: 'voiceover', characterId: null, text }] : [{ id: 'sound', type: 'sound', text: '远处钟声' }] }] } }));
  const shots = [1, 2].map(index => ({ id: index, chapter_id: `chapter-${index}`, index: 1, active_version: 1, duration: 5, asset_status: 'completed', asset_url: `/static/frame-${index}.png`, narration: index === 1 ? text : '', dialogue: '', audio_prompt: index === 2 ? '远处钟声' : '', shot_spec: { primary_subject: '山谷', location: '', key_props: [], source: { type: 'script', script_id: index, script_revision: 2, script_scene_id: `scene-${index}`, block_ids: [index === 1 ? 'voice' : 'sound'] } } }));
  const settings = { image_provider: 'comfyui', comfyui: { enabled: true }, tts: { enabled: true, base_url: 'http://127.0.0.1:8765' } };
  const project = { id: 99001, title: '隔离制作测试', settings: { image_generation: { nsfw_mode: 'off', style: 'test' } } };
  const media = [1, 2].map(index => [{ id: 100 + index, role: 'video_keyframe', status: 'ready', media_type: 'image', url: `/static/frame-${index}.png` }]);
  const counts = { images: [0, 0], videos: [0, 0], speech: 0 };
  const inputSignature = body => fingerprint({ body: { scene_id: body.scene_id, preset: body.preset, workflow_id: body.workflow_id }, settings: project.settings, shot: shots[body.scene_id - 1], keyframe: hash(path.join(staticRoot, `frame-${body.scene_id}.png`)) });
  const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
  for (const index of [1, 2]) {
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${index === 1 ? 'blue' : 'green'}:s=1280x720`, '-frames:v', '1', path.join(staticRoot, `frame-${index}.png`)]);
    const videoDir = path.join(staticRoot, `video-${index}`); fs.mkdirSync(videoDir);
    ffmpeg(['-f', 'lavfi', '-i', `color=c=${index === 1 ? 'blue' : 'green'}:s=1280x720:r=24`, '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '5', '-frames:v', '120', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(videoDir, 'final.mp4')]);
  }
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000', '-t', '9.8', path.join(staticRoot, 'speech.mp3')]);
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    let result;
    try {
      const url = req.url;
      if (url === '/api/settings/') result = settings;
      else if (url.includes('/settings/verify')) result = { status: 'success' };
      else if (url.startsWith('/api/videos/capabilities')) result = { video_generation_enabled: true, missing_components: [] };
      else if (url === '/api/projects/99001') result = project;
      else if (url.endsWith('/story-plan')) result = { revision: 1, document: { blueprint: { characters: [] } }, entries: chapters.map(chapter => ({ id: chapter.id, disposition: 'active', summary: '已有规划' })) };
      else if (url === '/api/assistant/chat') result = { response: '已有构思' };
      else if (url.startsWith('/api/chapters/?')) result = chapters;
      else if (/\/chapters\/chapter-[12]\/script$/.test(url)) result = { script: scripts[Number(url.match(/chapter-(\d)/)[1]) - 1] };
      else if (/\/scripts\/[12]\/export$/.test(url)) result = { markdown: '隔离剧本' };
      else if (/\/timeline\/chapter-[12]$/.test(url)) result = { timeline: [shots[Number(url.match(/chapter-(\d)/)[1]) - 1]] };
      else if (url.endsWith('/asset-references')) result = [];
      else if (url.includes('/media?')) result = { assets: media[Number(url.match(/scenes\/(\d+)/)[1]) - 1] };
      else if (url.startsWith('/api/characters/')) result = [];
      else if (url.includes('/asset-library')) result = [];
      else if (url.endsWith('/export')) result = { asset_library: { image_snapshots: shots.map(shot => ({ scene_id: shot.id, image_url: shot.asset_url, references_json: '[]', character_versions_json: '[]' })) } };
      else if (url === '/api/agent/consistency') result = { issues: [] };
      else if (url === '/api/assets/generate') { counts.images[body.scene_id - 1]++; result = { task_id: `image-${body.scene_id}` }; }
      else if (url.startsWith('/api/assets/status/')) result = { status: 'completed', image_url: `/static/frame-${Number(url.match(/image-(\d+)/)[1])}.png` };
      else if (url === '/api/videos/preflight') result = { ready: true, blockers: [], input_signature: inputSignature(body) };
      else if (url === '/api/videos/generate') {
        assert.equal(body.preset, 'standard_720p_5s'); assert.equal(body.expected_input_signature, inputSignature(body));
        counts.videos[body.scene_id - 1]++;
        const index = body.scene_id;
        media[index - 1].push({ id: 200 + index, role: 'narrative_final', media_type: 'video', status: 'draft', url: `/static/video-${index}/final.mp4`, sha256: hash(path.join(staticRoot, `video-${index}`, 'final.mp4')) });
        fs.writeFileSync(path.join(staticRoot, `video-${index}`, 'manifest.json'), JSON.stringify({ metadata: { request: { ...body, keyframe_asset_id: 100 + index, input_signature: inputSignature(body) } } }));
        result = { task_id: `video-${index}` };
      } else if (url.startsWith('/api/videos/tasks/')) result = { status: 'completed', stage: 'completed' };
      else if (url === '/api/tts/status') result = { ok: true, default_voice: 'QF1' };
      else if (url === '/api/tts/render-block') { counts.speech++; result = { asset: { status: 'ready', url: '/static/speech.mp3', sha256: hash(path.join(staticRoot, 'speech.mp3')) }, source: { text, voice_id: body.voice_id, script_id: body.script_id, script_revision: body.expected_revision, block_id: body.block_id } }; }
      else throw new Error(`Unexpected ${req.method} ${url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = path.join(folder, 'production');
  const run = async (stage = 'all', extra = []) => {
    const child = spawn(process.execPath, ['scripts/full-production.mjs', '--project', '99001', '--chapter-limit', '2', '--stage', stage, '--base-url', `http://127.0.0.1:${server.address().port}`, '--output', output, '--accept-legacy-storyboards', ...extra], { env: { ...process.env, NOVASTORY_STATIC_DIR: staticRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); return { code, log };
  };
  const approve = async (kind, index) => {
    const preview = JSON.parse(fs.readFileSync(path.join(output, `${kind}-chapter-chapter-${index}.json`), 'utf8'));
    const result = await run(kind, ['--chapter-id', `chapter-${index}`, '--reviewer', '隔离测试审核人', '--review-fingerprint', preview.fingerprint]);
    assert.equal(result.code, 0, result.log);
  };
  try {
    for (const index of [1, 2]) {
      let result = await run(); assert.equal(result.code, 1, result.log); assert.match(result.log, /images: human approval/);
      if (index === 1) assert.equal(counts.images[1], 0);
      await approve('review-images', index);
      result = await run(); assert.equal(result.code, 1, result.log); assert.match(result.log, /visual review/);
      media[index - 1].at(-1).status = 'ready';
      result = await run(); assert.equal(result.code, 1, result.log); assert.match(result.log, /chapter_ready: human approval/);
      if (index === 1) assert.equal(counts.images[1], 0);
      await approve('review-chapter', index);
    }
    const result = await run(); assert.equal(result.code, 0, result.log);
    const acceptance = JSON.parse(fs.readFileSync(path.join(output, 'acceptance.json'), 'utf8'));
    assert.equal(acceptance.acceptance.length, 17); assert.ok(acceptance.acceptance.every(item => item.status === 'PASS'), JSON.stringify(acceptance.acceptance));
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'videos', 'chapter-1.manifest.json'), 'utf8'));
    assert.ok(manifest.duration > 9.8); assert.equal(manifest.cues[0].text, text);
    const displayed = fs.readFileSync(manifest.subtitle_file, 'utf8').split('\n').filter(line => line && !/^\d+$/.test(line) && !line.includes(' --> ')).join('');
    assert.equal(displayed, text);
    assert.deepEqual(counts.images, [1, 1]); assert.deepEqual(counts.videos, [1, 1]); assert.equal(counts.speech, 1);
    project.settings.image_generation.style = 'changed';
    const stale = await run('verify'); assert.equal(stale.code, 1);
    const changed = JSON.parse(fs.readFileSync(path.join(output, 'acceptance.json'), 'utf8'));
    assert.equal(changed.acceptance.find(item => item.id === 'F16').status, 'FAIL');
    project.settings.image_generation.style = 'test';
    const originalFrame = fs.readFileSync(path.join(staticRoot, 'frame-1.png'));
    fs.appendFileSync(path.join(staticRoot, 'frame-1.png'), 'changed bytes');
    assert.equal((await run('verify')).code, 1);
    const bytesChanged = JSON.parse(fs.readFileSync(path.join(output, 'acceptance.json'), 'utf8'));
    assert.equal(bytesChanged.acceptance.find(item => item.id === 'F16').status, 'FAIL');
    fs.writeFileSync(path.join(staticRoot, 'frame-1.png'), originalFrame);
    fs.writeFileSync(path.join(staticRoot, 'speech.mp3'), 'missing valid speech');
    assert.equal((await run('verify')).code, 1);
    const speechChanged = JSON.parse(fs.readFileSync(path.join(output, 'acceptance.json'), 'utf8'));
    assert.equal(speechChanged.acceptance.find(item => item.id === 'F17').status, 'FAIL');
    const silentVideo = path.join(staticRoot, 'video-2', 'silent.mp4');
    const sourceVideo = path.join(staticRoot, 'video-2', 'final.mp4');
    ffmpeg(['-i', sourceVideo, '-map', '0:v:0', '-c:v', 'copy', '-an', silentVideo]);
    fs.copyFileSync(silentVideo, sourceVideo);
    media[1].find(asset => asset.role === 'narrative_final').sha256 = hash(sourceVideo);
    const missingSound = await run('assemble', ['--chapter-id', 'chapter-2']);
    assert.equal(missingSound.code, 1, missingSound.log);
    assert.match(missingSound.log, /requires sound effects but the accepted source has no audio/);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(folder, { recursive: true, force: true }); }
});
