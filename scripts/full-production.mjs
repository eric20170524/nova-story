import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveAssetBindings, resolveShotCharacter, resolveVisibleShotCharacters, keyframeUsesBindings } from './production-references.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const projectId = Number(option('project', '90713823'));
const chapterLimit = Number(option('chapter-limit', '5'));
const stage = option('stage', 'all');
const base = option('base-url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const directory = path.resolve(root, option('output', `local/production/${projectId}`));
const workflow = option('video-workflow', process.env.NOVASTORY_VIDEO_WORKFLOW || 'minimax_h3_ref2va_official_12gb');
const retryFailed = args.includes('--retry-failed');
const rebuildStoryboards = args.includes('--rebuild-storyboards');
const assetScopeArg = option('asset-scope', null);
const stages = ['preflight', 'text', 'scripts', 'assets', 'storyboards', 'images', 'video-preflight', 'videos', 'assemble', 'verify'];
if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(chapterLimit) || chapterLimit < 1 || chapterLimit > 5 || ![...stages, 'all'].includes(stage)) throw new Error('Invalid --project, --chapter-limit or --stage');
fs.mkdirSync(directory, { recursive: true });
const lockFile = path.join(directory, '.production.lock');
if (fs.existsSync(lockFile)) {
  const previous = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  let running = false;
  if (Number.isSafeInteger(previous.pid) && previous.pid > 0) {
    try { process.kill(previous.pid, 0); running = true; }
    catch (error) { if (error.code !== 'ESRCH') running = true; }
  }
  if (running) throw new Error(`Production output is already being updated by process ${previous.pid}`);
  fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
process.once('exit', () => {
  try {
    if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile);
  } catch {}
});
const stateFile = path.join(directory, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { projectId, steps: {}, startedAt: new Date().toISOString() };
if (state.projectId !== projectId) throw new Error('Output directory belongs to another project');
const assetScope = assetScopeArg || state.assetScope || 'all';
if (!['all', 'referenced'].includes(assetScope)) throw new Error('Invalid --asset-scope');
state.assetScope = assetScope;
const write = (name, value) => {
  const file = path.join(directory, name);
  fs.writeFileSync(`${file}.tmp`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
};
const save = () => write('state.json', state);
state.chapterLimit = chapterLimit;
save();
const hash = text => createHash('sha256').update(Buffer.isBuffer(text) ? text : String(text)).digest('hex');
const key = name => `production:${projectId}:${name}`;
async function request(url, method = 'GET', body) {
  if (body?.request_key) {
    const requestId = hash(`${url}:${body.request_key}`);
    state.requests ||= {};
    if (state.requests[requestId]) body = state.requests[requestId];
    else { state.requests[requestId] = body; save(); }
  }
  const response = await fetch(`${base}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch { throw new Error(`${url}: non-JSON response (${response.status})`); }
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function step(name, work) {
  if (state.steps[name]?.status === 'completed') return state.steps[name].result;
  console.log(`START ${name}`);
  state.currentStep = name; state.steps[name] = { ...(state.steps[name] || {}), status: 'running', startedAt: new Date().toISOString() }; save();
  try {
    const result = await work();
    state.steps[name] = { ...state.steps[name], status: 'completed', result, completedAt: new Date().toISOString() }; save();
    console.log(`DONE ${name}`); return result;
  } catch (error) {
    state.steps[name] = { ...state.steps[name], status: 'failed', error: error.message }; save(); throw error;
  }
}
const chapters = async () => (await request(`/chapters/?project_id=${projectId}`)).slice(0, chapterLimit);
const plan = () => request(`/projects/${projectId}/story-plan`);
const library = () => request(`/projects/${projectId}/asset-library`);
const characters = () => request(`/characters/?project_id=${projectId}`);
const shots = async () => (await Promise.all((await chapters()).map(c => request(`/timeline/${c.id}`)))).flatMap(r => r.timeline);
async function waitTask(taskId, video = false) {
  const deadline = Date.now() + (video ? 65 : 40) * 60 * 1000;
  while (Date.now() < deadline) {
    const task = await request(video ? `/videos/tasks/${taskId}` : `/assets/status/${taskId}`);
    if (['completed', 'review_required'].includes(task.status)) return task;
    if (['failed', 'cancelled', 'interrupted', 'rejected', 'UNKNOWN'].includes(task.status)) throw new Error(`Task ${taskId}: ${task.error || task.status}`);
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error(`Task ${taskId} is still running; preserve its ID and resume later`);
}
async function generateImage(name, start) {
  return step(name, async () => {
    const cached = state.steps[`${name}:submit`]?.result;
    if (cached && retryFailed) {
      const task = await request(`/assets/status/${cached.task_id}`);
      if (['failed', 'cancelled', 'interrupted'].includes(task.status)) {
        delete state.steps[`${name}:submit`]; state.imageAttempts ||= {}; state.imageAttempts[name] = (state.imageAttempts[name] || 0) + 1; save();
      }
    }
    const task = await step(`${name}:submit`, () => start(key(`${name}:attempt:${state.imageAttempts?.[name] || 0}`)));
    return waitTask(task.task_id);
  });
}
async function applyPlanCandidate(name, body) {
  if (retryFailed && state.steps[`${name}:candidate`]?.status === 'failed') {
    state.generationAttempts ||= {};
    state.generationAttempts[name] = (state.generationAttempts[name] || 0) + 1;
    save();
  }
  const candidate = await step(`${name}:candidate`, async () => {
    const current = await plan();
    return request(`/projects/${projectId}/story-plan/candidates`, 'POST', { ...body, expected_revision: current.revision, request_key: key(`${name}:attempt:${state.generationAttempts?.[name] || 0}`) });
  });
  if (candidate.state !== 'pending') throw new Error(`Candidate ${candidate.id}: ${candidate.state}`);
  return step(`${name}:apply`, async () => {
    return request(`/projects/${projectId}/story-plan/candidates/${candidate.id}/apply`, 'POST', {
      expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision,
      selected_patch_ids: candidate.patches.map(p => p.id),
    });
  });
}
const briefFile = option('brief-file', null);
let brief = briefFile ? fs.readFileSync(path.resolve(briefFile), 'utf8') : '以原创凡人小队为中心，创作独立五章修仙冒险短篇；不复写原著。以一件旧铜铃引出山村危机，推动调查、同伴分歧、代价和逆转，第五章解决本次危机。三至五名固定核心角色，三至五处可重复场景和三至五件核心道具，外观和名称固定。每章目标1600字，具体动作和对白，前后因果连续，无说明文字。';

async function preflight() {
  state.currentStep = 'preflight'; save();
  const settings = await request('/settings/');
  const codexImage = settings.image_provider === 'codex';
  const imageCheck = codexImage ? Promise.resolve().then(() => {
    const queue = path.resolve(root, process.env.NOVASTORY_CODEX_IMAGE_QUEUE_DIR || 'backend/codex-image-jobs');
    fs.mkdirSync(queue, { recursive: true });
    fs.accessSync(queue, fs.constants.W_OK);
    return { provider: 'codex', status: 'queue_writable', queue, worker: 'current Codex session imagegen' };
  }) : request('/settings/verify-comfy', 'POST', {});
  const checks = await Promise.allSettled([
    request(`/projects/${projectId}`), request('/settings/verify-llm', 'POST', {}),
    imageCheck, request(`/videos/capabilities?workflow_id=${workflow}`), library(),
  ]);
  const names = ['project', 'llm', codexImage ? 'image' : 'comfyui', 'video', 'asset_library'];
  const evidence = Object.fromEntries(checks.map((result, i) => [names[i], result.status === 'fulfilled' ? result.value : { error: result.reason.message }]));
  write('preflight.json', evidence);
  const blockers = checks.flatMap((result, i) => result.status === 'rejected' ? [`${names[i]}: ${result.reason.message}`] : []);
  if (evidence.video?.video_generation_enabled !== true) blockers.push(...(evidence.video?.missing_components || ['Video unavailable']));
  state.preflight = { checkedAt: new Date().toISOString(), blockers }; save();
  if (blockers.length) throw new Error(blockers.join('\n'));
  return evidence;
}
async function text() {
  const project = await request(`/projects/${projectId}`);
  const existingPlan = await plan();
  const canonicalNames = existingPlan.document.blueprint?.characters?.map(c => c.name).filter(Boolean) || [];
  brief = [
    `项目书名：《${project.title}》。必须准确使用该书名，不得用“沿用当前项目书名”等占位语。项目说明：${project.description || '无'}。`,
    canonicalNames.length ? `已经确认的角色姓名：${canonicalNames.join('、')}。沿用这些姓名和当前规划中的场景、道具。` : '',
    brief,
  ].filter(Boolean).join('\n');
  await step('brainstorm', async () => {
    const result = await request('/assistant/chat', 'POST', { message: brief, context: { project_id: projectId, surface: 'story', conversation_mode: 'ideation', language: 'zh' }, history: [] });
    write('01-brainstorm.txt', result.response); return result;
  });
  if (!(await plan()).document.blueprint) await applyPlanCandidate('blueprint', { kind: 'blueprint', message: brief });
  const initial = await plan();
  const active = initial.entries.filter(e => e.disposition === 'active');
  if (active.length > 5) throw new Error('Project already has more than five active plans; refusing to discard author work');
  const placeholders = active.filter(e => !e.summary.trim());
  if (placeholders.length) await applyPlanCandidate('revise-placeholder', { kind: 'chapters', mode: 'revise', target_plan_ids: placeholders.map(e => e.id), message: `${brief} 将空白规划改为第一章开场，明确危机与转机。` });
  if (active.length < 5) await applyPlanCandidate('plan-five', { kind: 'chapters', mode: 'extend', batch_size: 5 - active.length, message: `${brief} 补齐共五章的规划。最后一章解决铜铃危机。` });
  write('02-story-plan.json', await plan());
  for (let i = 0; i < chapterLimit; i++) {
    let currentChapters = await chapters();
    if (currentChapters.length <= i) await step(`chapter-${i + 1}:create`, async () => {
      const current = await plan();
      return request(`/projects/${projectId}/story-plan/next-chapter`, 'POST', {
        plan_entry_id: current.next_entry_id, expected_revision: current.revision,
        expected_last_chapter_id: currentChapters.at(-1)?.id || null, request_key: key(`chapter-${i + 1}`),
      });
    });
    const chapter = (await chapters())[i];
    if (!chapter.content?.trim()) {
      const draft = await step(`chapter-${i + 1}:draft`, () => request('/agent/draft', 'POST', {
        project_id: projectId, chapter_id: chapter.id, instructions: `${brief}\n按本章规划完成完整正文：${chapter.title}\n${chapter.summary}`, target_word_count: chapter.target_word_count || 1600, apply: false,
      }));
      if ((draft.content.match(/[\p{L}\p{N}]/gu) || []).length < (chapter.target_word_count || 1600) * 0.8) throw new Error(`Chapter ${i + 1} draft is below 80% of its target; inspect before accepting`);
      await step(`chapter-${i + 1}:save`, () => request(`/chapters/${chapter.id}`, 'PATCH', { content: draft.content }));
    }
    const latest = (await chapters())[i];
    if (latest.status !== 'completed' || latest.finalized_content_hash !== hash(latest.content)) {
      await step(`chapter-${i + 1}:finalize:${hash(latest.content).slice(0, 12)}`, () => request('/agent/impact', 'POST', { project_id: projectId, chapter_id: latest.id, apply: true }));
    }
    write(`03-chapter-${i + 1}.txt`, (await chapters())[i].content);
  }
  write('04-continuity-review.json', await step('continuity-review', () => request('/agent/consistency', 'POST', { project_id: projectId })));
}
async function scripts() {
  for (const chapter of await chapters()) {
    let script = (await request(`/chapters/${chapter.id}/script`, 'POST', {})).script;
    if (!script.document.scenes.length && script.document.outline.beats.length !== 4) {
      const name = `script-${script.id}:outline-compact`;
      const candidate = await step(`${name}:candidate`, () => request(`/scripts/${script.id}/candidates`, 'POST', {
        kind: 'outline', expected_revision: script.revision, request_key: key(`${name}:v1`), target_duration_sec: 60,
        instructions: '严格输出4个戏剧节拍，每个节拍对应一个分场，不是镜头。每个节拍概括一组连续事件，目的不写机位、秒数或对白。mustKeepEvents只列4至6个核心、可表演且简短的事件，每项不超过35字；4个节拍共同覆盖所有事件，保留本章起因、冲突、关键选择与结尾悬念。地点和人物名称沿用原文。',
      }).then(result => result.candidate));
      const compact = JSON.parse(candidate.after_json);
      if (compact.beats?.length !== 4 || compact.mustKeepEvents?.length > 6) throw new Error(`Script ${script.id} outline needs 4 beats and at most 6 essential events; got ${compact.beats?.length}/${compact.mustKeepEvents?.length}`);
      script = (await step(`${name}:apply`, () => request(`/scripts/${script.id}/candidates/${candidate.id}/apply`, 'POST', {
        expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision, request_key: key(`apply-${candidate.id}`),
      }))).script;
    }
    if (!script.document.scenes.length) {
      const kind = 'script';
      const candidate = await step(`script-${script.id}:${kind}:candidate`, () => request(`/scripts/${script.id}/candidates`, 'POST', {
        kind, expected_revision: script.revision, request_key: key(`script-${script.id}-${kind}-r${script.revision}-v2`), target_duration_sec: 60,
        instructions: '改编成60秒短剧，严格按已采纳的4个节拍写4场。每个本场涉及的必保事件必须单独写进一个action块：该块text先完整保留事件原句，再补充可见动作和短对白。不得只在coveredEventIds字段声称覆盖；系统将从实际表演块文字核验。场景与道具名称沿用原文和资产库。',
      }).then(result => result.candidate));
      script = (await step(`script-${script.id}:${kind}:apply`, () => request(`/scripts/${script.id}/candidates/${candidate.id}/apply`, 'POST', {
        expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision, request_key: key(`apply-${candidate.id}`),
      }))).script;
    }
    if (script.status !== 'confirmed') script = (await request(`/scripts/${script.id}/confirm`, 'POST', { expected_revision: script.revision, request_key: key(`confirm-${script.id}-${script.revision}`) })).script;
    write(`05-script-${chapter.index}.json`, script);
    const exported = await request(`/scripts/${script.id}/export`); write(`05-script-${chapter.index}.txt`, exported.markdown);
  }
}
async function assets() {
  for (const chapter of await chapters()) await step(`extract-assets:${chapter.id}:${hash(chapter.content).slice(0, 12)}`, () => request('/asset-library/extract', 'POST', { chapter_id: chapter.id }));
  const coreCharacterNames = new Set((await plan()).document.blueprint?.characters?.map(character => character.name) || []);
  if (!coreCharacterNames.size) throw new Error('Approve a story blueprint before generating character portraits');
  const knownCharacters = await characters();
  const primaryCharacterIds = new Set((await shots()).map(shot => resolveShotCharacter(shot, knownCharacters)?.id).filter(Boolean));
  for (let character of knownCharacters.filter(character => coreCharacterNames.has(character.name) || primaryCharacterIds.has(character.id))) {
    for (const type of ['portrait', 'turnaround']) {
      const slot = type === 'portrait' ? 'avatar_url' : 'turnaround_url';
      if (character[slot]) continue;
      const visualDescription = character.visual_tags?.visual_bible?.portrait_description || character.description;
      const referenceUrl = type === 'portrait' ? character.visual_tags?.visual_bible?.reference_image_url : character.avatar_url;
      const prompt = await step(`character-${character.id}:${type}:prompt`, () => request(`/characters/${character.id}/build-prompt`, 'POST', { gen_type: type, custom_description: visualDescription, use_ref_portrait: !!referenceUrl, ref_image_url: referenceUrl || undefined }));
      const task = await generateImage(`character-${character.id}:${type}`, requestKey => request('/assets/generate', 'POST', {
        scene_id: 90_000_000 + character.id, request_key: requestKey, workflow: { ...prompt, character_id: character.id, gen_type: type, character_ref_url: referenceUrl || undefined, ref_image_url: referenceUrl || undefined, reference_tier: 'A' },
      }));
      character = await request(`/characters/${character.id}`, 'PUT', { [slot]: task.image_url });
    }
  }
  const allAssets = await library();
  let selectedAssets = allAssets;
  if (assetScope === 'referenced') {
    const storyboardShots = await shots();
    if (storyboardShots.length) {
      const ids = new Set();
      for (const shot of storyboardShots) {
        const binding = resolveAssetBindings(shot, allAssets);
        if (binding.blockers.length) throw new Error(`Shot ${shot.id}: ${binding.blockers.join('; ')}`);
        binding.asset_ids.forEach(id => ids.add(id));
      }
      selectedAssets = allAssets.filter(asset => ids.has(asset.id));
    } else selectedAssets = [];
  }
  for (const asset of selectedAssets) {
    if (asset.status === 'generating' && asset.task_id) await waitTask(asset.task_id);
    else if (asset.status !== 'completed' || !asset.image_url) await generateImage(`library-${asset.id}:v${asset.revision}`, () => request(`/asset-library/${asset.id}/generate`, 'POST', {}));
  }
  write('06-characters.json', await characters()); write('06-asset-library.json', await library());
}
async function storyboards() {
  for (const chapter of await chapters()) {
    const existing = await request(`/timeline/${chapter.id}`);
    const script = (await request(`/chapters/${chapter.id}/script`)).script;
    if (script.status !== 'confirmed' || script.freshness?.sourceChanged) throw new Error(`Script ${script.id} must be confirmed and current`);
    if (existing.timeline.length) {
      const current = existing.timeline.every(shot => {
        const source = (typeof shot.shot_spec === 'string' ? JSON.parse(shot.shot_spec) : shot.shot_spec)?.source;
        return source?.type === 'script' && source.script_id === script.id && source.script_revision === script.revision;
      });
      if (current) continue;
      if (!rebuildStoryboards) throw new Error(`Script ${script.id}: existing storyboard uses an older or unverified source; review and run --rebuild-storyboards to retain a snapshot and replace it`);
    }
    const name = `storyboard-${script.id}:revision-${script.revision}`;
    const candidate = await step(`${name}:candidate`, () => request(`/scripts/${script.id}/storyboard-candidates`, 'POST', {
      expected_revision: script.revision, request_key: key(name), instructions: '生成12镜，每镜5秒。覆盖每场及全部台词和旁白块，每块只分配一次，保持时序。至少含20%的建立/远景镜头和一个道具插入镜头。location和key_props名称与正文和资产库完全一致，每镜只能有一个地点与一个连续动作，不合并药屋、村口、废祠。严格保留剧本的夜间、人物站位和安全石板外沿；老葛只在药屋和高地。镜头不得加入下渠涉水动作。',
    }).then(result => result.candidate));
    await step(`${name}:apply`, () => request(`/scripts/${script.id}/storyboard-candidates/${candidate.id}/apply`, 'POST', {
      expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision, request_key: key(`apply-${candidate.id}`),
      ...(existing.timeline.length ? { replace_existing: true, expected_scene_ids: existing.timeline.map(shot => shot.id) } : {}),
    }));
  }
  write('07-storyboards.json', await shots());
}
async function images() {
  const allAssets = await library();
  let knownCharacters;
  const snapshots = (await request(`/projects/${projectId}/export`)).asset_library?.image_snapshots || [];
  for (const shot of await shots()) {
    const existing = await request(`/timeline/scenes/${shot.id}/asset-references`);
    const binding = resolveAssetBindings(shot, allAssets, existing);
    if (binding.blockers.length) throw new Error(`Shot ${shot.id}: ${binding.blockers.join('; ')}; bind every required asset in Director and resume`);
    const refs = existing.length ? existing : await request(`/timeline/scenes/${shot.id}/asset-references`, 'PUT', { asset_ids: binding.asset_ids });
    if (refs.some(r => r.stale)) throw new Error(`Shot ${shot.id} has stale asset references`);
    if (shot.asset_status !== 'completed' || !shot.asset_url || !keyframeUsesBindings(shot, refs, snapshots)) {
      knownCharacters ||= await characters();
      const primary = resolveShotCharacter(shot, knownCharacters);
      const visibleCharacters = resolveVisibleShotCharacters(shot, knownCharacters);
      const signature = hash(JSON.stringify({ source: shot.asset_url, refs: refs.map(r => ({ id: r.id, revision: r.revision })), portraits: visibleCharacters.map(c => [c.id, c.avatar_url]) })).slice(0, 16);
      await generateImage(`shot-${shot.id}:image:${signature}`, requestKey => request('/assets/generate', 'POST', { scene_id: shot.id, request_key: requestKey, workflow: { gen_type: 'scene', character_ref_url: primary?.avatar_url || undefined, character_ref_urls: visibleCharacters.map(c => c.avatar_url) } }));
    }
  }
  write('08-rendered-storyboards.json', await shots());
}
async function videoPreflight() {
  const known = await characters();
  const results = [];
  for (const shot of await shots()) {
    const media = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
    const primary = resolveShotCharacter(shot, known);
    const references = (media.assets || []).filter(asset => asset.role === 'character_reference' && asset.status === 'ready' && asset.character_id === primary?.id).slice(0, 3).map(asset => asset.id);
    const body = { scene_id: shot.id, scene_version: shot.active_version || 1, workflow_id: workflow, profile: 'narrative_clip', preset: 'preview_480p_5s', character_reference_asset_ids: references, run_loop_closer: false };
    const check = await request('/videos/preflight', 'POST', body);
    const identityReady = !primary || references.length > 0;
    results.push({ scene_id: shot.id, chapter_id: shot.chapter_id, keyframe_ready: shot.asset_status === 'completed' && !!shot.asset_url, character_id: primary?.id || null, reference_asset_ids: references, ...check, identity_ready: identityReady, ready: check.ready && identityReady });
  }
  write('09-video-preflight.json', { chapterLimit, workflow, results });
  if (results.some(result => !result.keyframe_ready || !result.ready)) throw new Error('Some selected shots are not ready for video generation; see 09-video-preflight.json');
  return results;
}
async function videos() {
  const pendingReview = [];
  for (const shot of await shots()) {
    const available = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
    const known = await characters();
    const readyVideo = (available.assets || []).filter(a => a.role === 'narrative_final' && a.status === 'ready').at(-1);
    if (readyVideo) {
      const provenance = videoProvenance(shot, available.assets, known);
      if (provenance.source_current && provenance.identity_current) continue;
    }
    const refs = (available.assets || []).filter(a => a.role === 'character_reference' && a.character_id != null && a.status === 'ready');
    const primary = resolveShotCharacter(shot, known);
    const selectedRefs = primary ? refs.filter(a => a.character_id === primary.id).slice(0, 3).map(a => a.id) : [];
    if (primary && !selectedRefs.length) throw new Error(`Shot ${shot.id}: missing generated identity references for ${primary.name}`);
    const signature = hash(JSON.stringify({ source: shot.asset_url, version: shot.active_version || 1, selectedRefs, workflow })).slice(0, 16);
    const name = `shot-${shot.id}:video:${signature}`;
    await step(name, async () => {
      const submittedKey = `${name}:submit`;
      const cached = state.steps[submittedKey]?.result;
      if (cached && retryFailed) {
        const task = await request(`/videos/tasks/${cached.task_id}`);
        if (['failed', 'cancelled', 'interrupted', 'rejected'].includes(task.status)) {
          delete state.steps[submittedKey]; state.videoAttempts ||= {}; state.videoAttempts[shot.id] = (state.videoAttempts[shot.id] || 0) + 1; save();
        }
      }
      const body = { scene_id: shot.id, scene_version: shot.active_version || 1, workflow_id: workflow, profile: 'narrative_clip', preset: 'preview_480p_5s', character_reference_asset_ids: selectedRefs, run_loop_closer: false,
        request_key: key(`${name}-attempt-${state.videoAttempts?.[shot.id] || 0}`) };
      const flight = await request('/videos/preflight', 'POST', body); write(`preflight-shot-${shot.id}.json`, flight);
      if (!flight.ready) throw new Error(`Shot ${shot.id}: ${flight.blockers.join('; ')}`);
      const submitted = await step(submittedKey, () => request('/videos/generate', 'POST', body));
      const task = await waitTask(submitted.task_id, true);
      write(`09-video-task-${shot.id}.json`, task);
      return task;
    });
    pendingReview.push(shot.id);
  }
  if (pendingReview.length) throw new Error(`Generated videos need visual review and promotion before assembly (shots: ${pendingReview.join(', ')}); resume after reviewing in Director`);
}
const staticRoot = path.resolve(root, process.env.NOVASTORY_STATIC_DIR || 'backend/static');
function localMedia(url) {
  if (!String(url).startsWith('/static/')) throw new Error(`Expected a system-local media URL: ${url}`);
  const file = path.resolve(staticRoot, url.slice('/static/'.length));
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file)) throw new Error(`Missing local media: ${url}`);
  return file;
}
function videoProvenance(shot, assets, characters_) {
  const primary = resolveShotCharacter(shot, characters_);
  try {
    const final = assets.filter(a => a.role === 'narrative_final' && a.status === 'ready').at(-1);
    if (!final) throw new Error('No accepted final video');
    let manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(localMedia(final.url)), 'manifest.json'), 'utf8'));
    if (!manifest.metadata?.request && manifest.metadata?.reprocess) {
      const raw = assets.find(a => a.id === final.parent_asset_id);
      if (!raw) throw new Error('Missing original video provenance');
      manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(localMedia(raw.url)), 'manifest.json'), 'utf8'));
    }
    const generation = manifest.metadata?.request;
    if (!generation) throw new Error('Missing generation request in video manifest');
    const referenceIds = generation.character_reference_asset_ids || [];
    const references = assets.filter(a => referenceIds.includes(a.id));
    const keyframe = assets.find(a => a.id === generation.keyframe_asset_id);
    return {
      scene_id: shot.id, character_id: primary?.id || null, reference_ids: referenceIds,
      identity_current: !primary || (referenceIds.length > 0 && references.length === referenceIds.length && references.every(a => a.role === 'character_reference' && a.status === 'ready' && a.character_id === primary.id)),
      source_current: generation.scene_id === shot.id && generation.scene_version === (shot.active_version || 1) && keyframe?.url === shot.asset_url,
    };
  } catch (error) { return { scene_id: shot.id, character_id: primary?.id || null, identity_current: false, source_current: false, error: error.message }; }
}
function command(binary, arguments_) {
  const result = spawnSync(binary, arguments_, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary}: ${(result.stderr || result.error?.message || '').slice(-2500)}`);
  return result.stdout;
}
const probe = file => JSON.parse(command('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
async function assemble() {
  const videoDirectory = path.join(directory, 'videos'); fs.mkdirSync(videoDirectory, { recursive: true });
  const clipFiles = []; const chapterFiles = [];
  const [known, assets, backup] = await Promise.all([characters(), library(), request(`/projects/${projectId}/export`)]);
  for (const chapter of await chapters()) {
    const chapterShots = (await request(`/timeline/${chapter.id}`)).timeline;
    for (const shot of chapterShots) {
      const available = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
      const final = (available.assets || []).filter(a => a.role === 'narrative_final' && a.status === 'ready').at(-1);
      if (!final) throw new Error(`Shot ${shot.id} has no accepted final video`);
      const refs = await request(`/timeline/scenes/${shot.id}/asset-references`);
      const provenance = videoProvenance(shot, available.assets, known);
      if (!provenance.source_current || !provenance.identity_current || !keyframeUsesBindings(shot, refs, backup.asset_library?.image_snapshots || []) || resolveAssetBindings(shot, assets, refs).blockers.length) throw new Error(`Shot ${shot.id} has stale or incomplete asset/video provenance; regenerate and review before assembly`);
      const source = localMedia(final.url); const info = probe(source);
      const output = path.join(videoDirectory, `shot-${shot.id}.mp4`);
      const hasAudio = info.streams.some(s => s.codec_type === 'audio');
      command('ffmpeg', ['-y', '-i', source, ...(!hasAudio ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
        '-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-vf', 'scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', output]);
      clipFiles.push(output);
    }
    const list = path.join(videoDirectory, `chapter-${chapter.index}.concat.txt`);
    const chapterClips = clipFiles.slice(-chapterShots.length);
    fs.writeFileSync(list, chapterClips.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
    const final = path.join(videoDirectory, `chapter-${chapter.index}.mp4`);
    command('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]); chapterFiles.push(final);
  }
  if (!chapterFiles.length) throw new Error('No chapters to assemble');
  const list = path.join(videoDirectory, 'full.concat.txt'); fs.writeFileSync(list, chapterFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  const final = path.join(videoDirectory, chapterLimit === 5 ? 'full-story.mp4' : `chapters-1-${chapterLimit}.mp4`);
  command('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
  write('10-video-delivery.json', { chapterLimit, chapters: chapterFiles.map(file => ({ file, probe: probe(file) })), final: { file: final, probe: probe(final) } });
}
async function verify() {
  state.currentStep = 'verify'; save();
  const [cs, ps, chars, assets, ss] = await Promise.all([chapters(), plan(), characters(), library(), shots()]);
  const coreCharacterNames = new Set(ps.document.blueprint?.characters?.map(character => character.name) || []);
  const coreCharacters = chars.filter(character => coreCharacterNames.has(character.name));
  const screenplay = await Promise.all(cs.map(c => request(`/chapters/${c.id}/script`).then(r => r.script)));
  const media = await Promise.all(ss.map(s => request(`/scenes/${s.id}/media?version=${s.active_version || 1}`)));
  const requiredAssetIds = assetScope === 'referenced'
    ? new Set(ss.flatMap(shot => resolveAssetBindings(shot, assets).asset_ids))
    : new Set(assets.map(asset => asset.id));
  const requiredAssets = assets.filter(asset => requiredAssetIds.has(asset.id));
  const acceptance = [
    ['F01', '五章规划', ps.entries.filter(e => e.disposition === 'active').length === 5],
    ['F02', `前${chapterLimit}章正文非空且定稿哈希一致`, cs.length === chapterLimit && cs.every(c => c.content?.trim() && c.status === 'completed' && c.finalized_content_hash === hash(c.content))],
    ['F03', '章节字数达到规划的80%', cs.length === chapterLimit && cs.every(c => (c.content?.match(/[\p{L}\p{N}]/gu) || []).length >= c.target_word_count * 0.8)],
    ['F04', `前${chapterLimit}章剧本已确认且来源有效`, screenplay.length === chapterLimit && screenplay.every(s => s?.status === 'confirmed' && !s.freshness?.sourceChanged && s.document.scenes.length)],
    ['F05', '蓝图核心角色有定妆照和三视图', coreCharacters.length === coreCharacterNames.size && coreCharacters.every(c => c.avatar_url && c.turnaround_url)],
    ['F06', assetScope === 'referenced' ? '场景与道具独立且分镜引用素材全部已生成' : '场景与道具独立且全部已生成', requiredAssets.some(a => a.kind === 'location') && requiredAssets.some(a => a.kind === 'prop') && requiredAssets.every(a => a.status === 'completed' && a.image_url)],
    ['F07', `前${chapterLimit}章分镜均生成图片`, cs.length === chapterLimit && cs.every(c => ss.some(s => s.chapter_id === c.id)) && ss.every(s => s.asset_status === 'completed' && s.asset_url)],
    ['F08', '所有镜头有已验收视频', ss.length > 0 && media.every(r => r.assets.some(a => a.role === 'narrative_final' && a.status === 'ready'))],
    ['F09', `前${chapterLimit}章合成和阶段总片已输出`, (() => {
      const file = path.join(directory, '10-video-delivery.json');
      if (!fs.existsSync(file)) return false;
      const delivery = JSON.parse(fs.readFileSync(file, 'utf8'));
      return delivery.chapterLimit === chapterLimit && delivery.chapters?.length === chapterLimit && fs.existsSync(delivery.final?.file || '');
    })()],
  ].map(([id, criterion, pass]) => ({ id, criterion, status: pass ? 'PASS' : 'FAIL' }));
  const imageUrls = [...coreCharacters.flatMap(c => [c.avatar_url, c.turnaround_url]), ...requiredAssets.map(a => a.image_url), ...ss.map(s => s.asset_url)].filter(Boolean);
  const imageEvidence = imageUrls.map(url => {
    try { const file = localMedia(url); const info = probe(file); const video = info.streams.find(s => s.codec_type === 'video'); return { url, valid: video?.width >= 256 && video?.height >= 256, width: video?.width, height: video?.height, sha256: hash(fs.readFileSync(file)) }; }
    catch (error) { return { url, valid: false, error: error.message }; }
  });
  const shotReferences = await Promise.all(ss.map(s => request(`/timeline/scenes/${s.id}/asset-references`)));
  const backup = await request(`/projects/${projectId}/export`);
  acceptance.push({ id: 'F10', criterion: '素材和分镜图片文件存在、可解码且尺寸合格', status: imageEvidence.length > 0 && imageEvidence.every(e => e.valid) ? 'PASS' : 'FAIL' });
  const bindingEvidence = ss.map((shot, index) => ({ scene_id: shot.id, ...resolveAssetBindings(shot, assets, shotReferences[index]), keyframe_current: keyframeUsesBindings(shot, shotReferences[index], backup.asset_library?.image_snapshots || []) }));
  acceptance.push({ id: 'F11', criterion: '镜头完整引用所需场景和道具且关键帧使用当前素材', status: ss.length > 0 && shotReferences.every(refs => refs.length) && bindingEvidence.every(e => !e.blockers.length && e.keyframe_current) ? 'PASS' : 'FAIL' });
  let deliveryEvidence;
  try {
    const videos = Array.from({ length: chapterLimit }, (_, i) => path.join(directory, 'videos', `chapter-${i + 1}.mp4`));
    const final = path.join(directory, 'videos', chapterLimit === 5 ? 'full-story.mp4' : `chapters-1-${chapterLimit}.mp4`);
    deliveryEvidence = [...videos, final].map(file => ({ file, probe: probe(file), sha256: hash(fs.readFileSync(file)) }));
    const valid = deliveryEvidence.every(e => e.probe.streams.some(s => s.codec_type === 'video') && e.probe.streams.some(s => s.codec_type === 'audio') && Number(e.probe.format.duration) > 0);
    const expected = deliveryEvidence.slice(0, chapterLimit).reduce((sum, e) => sum + Number(e.probe.format.duration), 0);
    acceptance.push({ id: 'F12', criterion: `前${chapterLimit}章和阶段总片均可解码、含音轨且总片时长完整`, status: valid && Math.abs(Number(deliveryEvidence[chapterLimit].probe.format.duration) - expected) < 1 ? 'PASS' : 'FAIL' });
  } catch (error) { deliveryEvidence = { error: error.message }; acceptance.push({ id: 'F12', criterion: `前${chapterLimit}章和阶段总片均可解码、含音轨且总片时长完整`, status: 'FAIL' }); }
  const identityEvidence = ss.map((shot, index) => videoProvenance(shot, media[index].assets, chars));
  acceptance.push({ id: 'F13', criterion: '主角视频实际使用同一角色的有效定妆参考', status: identityEvidence.some(e => e.character_id != null) && identityEvidence.every(e => e.identity_current) ? 'PASS' : 'FAIL' });
  acceptance.push({ id: 'F14', criterion: '视频来源与当前关键帧及镜头版本一致', status: ss.length > 0 && identityEvidence.every(e => e.source_current) ? 'PASS' : 'FAIL' });
  const scriptEvidence = ss.map(shot => {
    const script = screenplay[cs.findIndex(chapter => chapter.id === shot.chapter_id)];
    let source;
    try { source = (typeof shot.shot_spec === 'string' ? JSON.parse(shot.shot_spec) : shot.shot_spec)?.source; } catch {}
    const scene = script?.document?.scenes?.find(scene => scene.id === source?.script_scene_id);
    const current = script?.status === 'confirmed' && !script.freshness?.sourceChanged && source?.type === 'script' && source.script_id === script.id && source.script_revision === script.revision && !!scene && (source.block_ids || []).every(id => scene.blocks.some(block => block.id === id));
    return { scene_id: shot.id, script_id: script?.id || null, script_revision: script?.revision || null, source: source || null, current: !!current };
  });
  acceptance.push({ id: 'F15', criterion: '分镜来源与已确认剧本修订及原声文本块一致', status: scriptEvidence.length > 0 && scriptEvidence.every(item => item.current) ? 'PASS' : 'FAIL' });
  write('media-quality.json', { images: imageEvidence, bindings: bindingEvidence, identities: identityEvidence, scripts: scriptEvidence, delivery: deliveryEvidence });
  write('acceptance.json', { checkedAt: new Date().toISOString(), chapterLimit, acceptance, counts: { chapters: cs.length, characters: chars.length, locations: assets.filter(a => a.kind === 'location').length, props: assets.filter(a => a.kind === 'prop').length, requiredAssets: requiredAssets.length, generatedAssets: assets.filter(a => a.status === 'completed' && a.image_url).length, shots: ss.length }, manualReview: [`前${chapterLimit}章因果和人物动机`, '跨镜头脸型服装及道具形状一致性', '画面缺陷和声音对白同步'] });
  write('project-backup.novastory.json', backup);
  if (acceptance.some(a => a.status !== 'PASS')) throw new Error('Acceptance has failing items; see acceptance.json');
}
function report(error) {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const scopeLabel = chapterLimit === 5 ? '五章完整' : `前${chapterLimit}章阶段`;
  const acceptance = fs.existsSync(path.join(directory, 'acceptance.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'acceptance.json'), 'utf8')) : null;
  const engineeringFile = path.join(directory, 'engineering.json');
  const engineering = fs.existsSync(engineeringFile) ? JSON.parse(fs.readFileSync(engineeringFile, 'utf8')) : null;
  const manualFile = path.join(directory, 'manual-review.json');
  const manualReview = fs.existsSync(manualFile) ? JSON.parse(fs.readFileSync(manualFile, 'utf8')) : null;
  write('report.html', `<!doctype html><html lang="zh"><meta charset="utf-8"><title>NovaStory ${scopeLabel}生成验收</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:24px;line-height:1.65;color:#172033;background:#f4f6fa}h1{font-size:28px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;background:white;padding:20px;border-left:4px solid #5965d8}.ok{color:#16803a}.bad{color:#b33939}</style><h1>项目 ${projectId} · ${scopeLabel}生成验收</h1><p>本次验收仅覆盖前${chapterLimit}章；后续章节的既有素材保留，不计入本次通过条件。</p><p>生成时间：${escape(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</p><p>当前状态：${error ? '尚未完成' : '所选阶段执行完成'}；当前步骤：${escape(state.currentStep)}</p>${error ? `<pre>${escape(error.message)}</pre>` : ''}${engineering ? `<h2>功能核查与工程验证</h2><table>${engineering.checks.map(c => `<tr><td>${escape(c.name)}</td><td>${escape(c.status)}</td><td>${escape(c.evidence)}</td></tr>`).join('')}</table><h2>已完成的修复</h2><ul>${engineering.changes.map(c => `<li>${escape(c)}</li>`).join('')}</ul>` : ''}${state.preflight?.blockers?.length ? `<h2>实生成阻塞</h2><pre>${escape(state.preflight.blockers.join('\n'))}</pre>` : ''}<h2>执行记录</h2><table><tr><th>步骤</th><th>状态</th><th>说明</th></tr>${Object.entries(state.steps).map(([name, step]) => `<tr><td>${escape(name)}</td><td>${escape(step.status)}</td><td>${escape(step.error || step.completedAt || '')}</td></tr>`).join('')}</table>${acceptance ? `<h2>验收矩阵</h2><table>${acceptance.acceptance.map(a => `<tr><td>${escape(a.id)}</td><td>${escape(a.criterion)}</td><td class="${a.status === 'PASS' ? 'ok' : 'bad'}">${escape(a.status)}</td></tr>`).join('')}</table>` : '<p>产物尚未齐备，未判定内容、视觉或视频质量通过。</p>'}${manualReview ? `<h2>人工质量复核</h2><table>${manualReview.checks.map(item => `<tr><td>${escape(item.name)}</td><td>${escape(item.status)}</td><td>${escape(item.evidence)}</td></tr>`).join('')}</table><p>复核证据：${(manualReview.evidenceFiles || []).map(file => `<a href="./${escape(path.basename(file))}">${escape(path.basename(file))}</a>`).join(' · ')}</p>` : ''}<h2>实际生成与人工质量核验</h2><p>只有本项目真实产物齐备才可通过内容验收。跨镜头角色一致性、道具形状、对白及声音同步必须观看实生成结果后判定。角色、场景和道具参考通过系统的 Codex 图像任务传递；跨镜头外观仍需逐张目视核验，接口或单元测试不能代替画面验收。</p><p>续跑：<code>npm run production:full -- --project ${projectId} --base-url ${escape(base)} --chapter-limit ${chapterLimit} --asset-scope ${assetScope} --video-workflow ${escape(workflow)} --retry-failed</code></p><p>同目录 JSON、文本和视频保留分阶段证据。人工验收需检查人物一致性、叙事质量及音画同步。</p></html>`);
}
let failure;
try {
  const handlers = { preflight, text, scripts, assets, storyboards, images, 'video-preflight': videoPreflight, videos, assemble, verify };
  for (const name of stage === 'all' ? stages : [stage]) {
    // Runtime preflight is deliberately rechecked on every resume; it is never cached.
    if (name === 'preflight') await preflight(); else await handlers[name]();
    if (stage === 'all' && name === 'storyboards' && assetScope === 'referenced') await assets();
  }
} catch (error) { failure = error; console.error(error.message); process.exitCode = 1; }
finally { report(failure); }
