import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveAssetBindings, resolveShotCharacter, resolveVisibleShotCharacters, resolveVisibleShotCast, keyframeUsesBindings, keyframeUsesCharacterVersions, chooseShotVideoStrategy, readProjectVideoWorkflow, coreCharactersReadyForAcceptance } from './production-references.mjs';
import { localQueueDir } from './local-queue.mjs';
import { assertChapterClipReady, assertNonEmptyChapterShots } from './video-delivery-contract.mjs';
import { fingerprint, shotContract, validateScriptCoverage, spokenBlocks, timedSpeech, subtitles, assertReview } from './production-contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
const projectArg = option('project', '');
const projectId = Number(projectArg);
const chapterLimit = Number(option('chapter-limit', '5'));
const stage = option('stage', 'all');
const base = option('base-url', 'http://127.0.0.1:3000').replace(/\/$/, '');
const directory = path.resolve(root, option('output', `local/production/${Number.isSafeInteger(projectId) ? projectId : 'unset'}`));
const requestedWorkflow = option('video-workflow', process.env.NOVASTORY_VIDEO_WORKFLOW || null);
const videoWorkflowFromCli = args.includes('--video-workflow');
const allowGrokVideo = videoWorkflowFromCli && requestedWorkflow === 'grok_imagine_browser';
const workflowOverride = requestedWorkflow === 'grok_imagine_browser' && !allowGrokVideo ? null : requestedWorkflow;
const workflow = workflowOverride || 'minimax_h3_ref2va_official_12gb';
const retryFailed = args.includes('--retry-failed');
const allowCodexImage = args.includes('--allow-codex-image');
const rebuildScripts = args.includes('--rebuild-scripts');
const rebuildAssets = args.includes('--rebuild-assets');
const rebuildStoryboards = args.includes('--rebuild-storyboards') || rebuildScripts;
const acceptLegacyStoryboards = args.includes('--accept-legacy-storyboards');
const assetScopeArg = option('asset-scope', null);
const selectedChapterId = option('chapter-id', null);
const narratorVoice = option('narrator-voice', null);
const stages = ['preflight', 'text', 'review-continuity', 'review-task-order', 'scripts', 'assets', 'storyboards', 'images', 'review-images', 'review-chapter', 'audio', 'video-preflight', 'videos', 'assemble', 'verify'];
if (!projectArg || !Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(chapterLimit) || chapterLimit < 1 || chapterLimit > 200 || ![...stages, 'all'].includes(stage)) throw new Error('Invalid --project, --chapter-limit or --stage');
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
function takeRebuildToken(slot) {
  state.rebuildSerial ||= {};
  if (retryFailed && state.rebuildSerial[slot]) return `:rebuild:${state.rebuildSerial[slot]}`;
  state.rebuildSerial[slot] = (state.rebuildSerial[slot] || 0) + 1;
  save();
  return `:rebuild:${state.rebuildSerial[slot]}`;
}
const scriptRebuildToken = rebuildScripts ? takeRebuildToken('scripts') : '';
const storyboardRebuildToken = rebuildStoryboards ? takeRebuildToken('storyboards') : '';
const assetRebuildToken = rebuildAssets ? takeRebuildToken('assets') : '';
const hash = text => createHash('sha256').update(Buffer.isBuffer(text) ? text : String(text)).digest('hex');
const key = name => `production:${projectId}:${name}`;
let activeProductionChapterId = null;
async function submitProductionTask(kind, submissionStep, submit) {
  if (!activeProductionChapterId) throw new Error(`Missing chapter context for ${kind} submission`);
  state.taskSubmissions ||= [];
  state.taskSubmissions.push({ chapter_id: activeProductionChapterId, kind, submission_step: submissionStep, submitted_at: new Date().toISOString() });
  save();
  return submit();
}
async function request(url, method = 'GET', body) {
  if (body?.request_key) {
    const requestId = hash(`${url}:${body.request_key}`);
    state.requests ||= {};
    if (state.requests[requestId]) {
      if (JSON.stringify(body) !== JSON.stringify(state.requests[requestId])) throw new Error(`Request key parameters changed: ${url}`);
      body = state.requests[requestId];
    }
    else { state.requests[requestId] = body; save(); }
  }
  const response = await fetch(`${base}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch { throw new Error(`${url}: non-JSON response (${response.status})`); }
  if (!response.ok) {
    const error = new Error(`${url}: HTTP ${response.status} ${JSON.stringify(result)}`);
    error.status = response.status; error.code = result.code; throw error;
  }
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
const selectedShots = async (selected) => {
  const all = await shots();
  if (!selected) return all;
  const ids = new Set(selected.map(chapter => chapter.id));
  return all.filter(shot => ids.has(shot.chapter_id));
};
const mentionsChapter = (asset, chapterId) => {
  try {
    const ids = JSON.parse(asset.source_chapter_ids || '[]');
    return Array.isArray(ids) && ids.includes(chapterId);
  } catch { return false; }
};
const plan = () => request(`/projects/${projectId}/story-plan`);
const library = () => request(`/projects/${projectId}/asset-library`);
const characters = () => request(`/characters/?project_id=${projectId}`);
const shots = async () => (await Promise.all((await chapters()).map(c => request(`/timeline/${c.id}`)))).flatMap(r => r.timeline);
async function waitTask(taskId, video = false) {
  const deadline = Date.now() + (video ? 7 * 60 : 40) * 60 * 1000;
  while (Date.now() < deadline) {
    const task = await request(video ? `/videos/tasks/${taskId}` : `/assets/status/${taskId}`);
    if (['completed', 'review_required'].includes(task.status)) return task;
    if (['failed', 'cancelled', 'interrupted', 'rejected', 'UNKNOWN'].includes(task.status)) throw new Error(`Task ${taskId}: ${task.error || task.status}`);
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error(`Task ${taskId} is still running; preserve its ID and resume later`);
}
async function generateImage(name, start) {
  const completed = state.steps[name];
  if (completed?.status === 'completed') {
    let valid = false;
    try { const digest = fileHash(localMedia(completed.result.image_url)); valid = !completed.result.artifact_sha256 || completed.result.artifact_sha256 === digest; } catch {}
    if (!valid) {
      if (!retryFailed) throw new Error(`${name}: cached image is missing or changed; inspect and use --retry-failed to generate a replacement`);
      delete state.steps[name]; delete state.steps[`${name}:submit`]; state.imageAttempts ||= {}; state.imageAttempts[name] = (state.imageAttempts[name] || 0) + 1; save();
    }
  }
  return step(name, async () => {
    const cached = state.steps[`${name}:submit`]?.result;
    if (cached && retryFailed) {
      const task = await request(`/assets/status/${cached.task_id}`);
      if (['failed', 'cancelled', 'interrupted'].includes(task.status)) {
        delete state.steps[`${name}:submit`]; state.imageAttempts ||= {}; state.imageAttempts[name] = (state.imageAttempts[name] || 0) + 1; save();
      }
    }
    const task = await step(`${name}:submit`, () => submitProductionTask('image', `${name}:submit`, () => start(key(`${name}:attempt:${state.imageAttempts?.[name] || 0}`))));
    const result = await waitTask(task.task_id);
    return { ...result, artifact_sha256: fileHash(localMedia(result.image_url)) };
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
let brief = briefFile ? fs.readFileSync(path.resolve(briefFile), 'utf8') : '按项目现有书名、说明和已确认设定创作。角色、场景和道具的名称保持稳定。每章写出可表演的动作和对白，前后因果连续，不要写说明文字。';

let cachedProjectVideoWorkflow;
let projectRequestsGrokVideo = false;
function projectSettingsOf(project) {
  if (!project || project.error) return {};
  if (typeof project.settings === 'string') {
    try { return JSON.parse(project.settings || '{}'); } catch { return {}; }
  }
  return project.settings || {};
}
async function projectVideoDefault() {
  if (workflowOverride) return null;
  if (cachedProjectVideoWorkflow !== undefined) return cachedProjectVideoWorkflow;
  try {
    const project = await request(`/projects/${projectId}`);
    const selected = readProjectVideoWorkflow(projectSettingsOf(project));
    projectRequestsGrokVideo = selected === 'grok_imagine_browser';
    cachedProjectVideoWorkflow = projectRequestsGrokVideo ? null : selected;
  } catch {
    cachedProjectVideoWorkflow = null;
  }
  return cachedProjectVideoWorkflow;
}
function providerBlockers(settings) {
  const blockers = [];
  const provider = String(settings?.image_provider || '').toLowerCase();
  const comfyEnabled = settings?.comfyui?.enabled === true;
  if (!allowCodexImage && (provider === 'codex' || provider === 'grok' || !comfyEnabled)) {
    blockers.push('生图和生视频默认使用已启用的本机 ComfyUI，并遵守项目图像设置。Codex 或 Grok 内置生图只有在明确要求时才加 --allow-codex-image。');
  }
  if (allowCodexImage && (provider !== 'codex' || comfyEnabled)) {
    blockers.push('--allow-codex-image 仅在 image_provider=codex 且 comfyui.enabled=false 时启用 Codex 图像队列；当前配置不会走该通路。');
  }
  if (process.env.NOVASTORY_VIDEO_WORKFLOW === 'grok_imagine_browser' && !allowGrokVideo) {
    blockers.push('NOVASTORY_VIDEO_WORKFLOW=grok_imagine_browser 不会自动生效。只有明确要求时才传入 --video-workflow grok_imagine_browser。');
  }
  if (projectRequestsGrokVideo && !allowGrokVideo) {
    blockers.push('项目 video_generation.workflow_id 是 grok_imagine_browser。默认制作改用 ComfyUI；只有明确要求时才传入 --video-workflow grok_imagine_browser。');
  }
  return blockers;
}
function keyframeOutputBlocker(project) {
  const image = projectSettingsOf(project).image_generation || {};
  const model = image.model || 'pony';
  const output = image.output_spec || {};
  const resolution = output.resolution || 'standard';
  const ratio = output.aspect_ratio || '16:9';
  if (model === 'sd15' || resolution === 'draft' || ratio !== '16:9' || output.orientation_policy === 'auto_by_shot') {
    return `项目关键帧设置 ${model}/${resolution}/${ratio}/${output.orientation_policy || 'fixed'} 无法保证 1280×720、16:9；请在项目图像设置中选择支持的模型、standard 或 high、固定 16:9 后再生成。`;
  }
  return null;
}
async function assertProductionProviders() {
  const [settings, projectWorkflow] = await Promise.all([request('/settings/'), projectVideoDefault()]);
  const blockers = providerBlockers(settings);
  if (blockers.length) throw new Error(blockers.join('\n'));
  return { settings, projectWorkflow };
}
async function preflight() {
  state.currentStep = 'preflight'; save();
  const settings = await request('/settings/');
  const projectWorkflow = await projectVideoDefault();
  const activeVideoWorkflow = workflowOverride || projectWorkflow || workflow;
  const provider = String(settings.image_provider || '').toLowerCase();
  const useCodexQueue = allowCodexImage && provider === 'codex' && settings.comfyui?.enabled !== true;
  const imageCheck = useCodexQueue ? Promise.resolve().then(() => {
    const queue = localQueueDir('NOVASTORY_CODEX_IMAGE_QUEUE_DIR', 'codex-image-jobs');
    fs.mkdirSync(queue, { recursive: true });
    fs.accessSync(queue, fs.constants.W_OK);
    return { provider: 'codex', status: 'queue_writable', queue, worker: 'explicit Codex image queue' };
  }) : request('/settings/verify-comfy', 'POST', {});
  const checks = await Promise.allSettled([
    request(`/projects/${projectId}`), request('/settings/verify-llm', 'POST', {}),
    imageCheck, request(`/videos/capabilities?workflow_id=${activeVideoWorkflow}`), library(),
  ]);
  const names = ['project', 'llm', useCodexQueue ? 'image' : 'comfyui', 'video', 'asset_library'];
  const evidence = Object.fromEntries(checks.map((result, i) => [names[i], result.status === 'fulfilled' ? result.value : { error: result.reason.message }]));
  if (!projectRequestsGrokVideo) {
    projectRequestsGrokVideo = readProjectVideoWorkflow(projectSettingsOf(evidence.project)) === 'grok_imagine_browser';
  }
  write('preflight.json', evidence);
  const blockers = checks.flatMap((result, i) => result.status === 'rejected' ? [`${names[i]}: ${result.reason.message}`] : []);
  for (const binary of ['ffmpeg', 'ffprobe']) { try { command(binary, ['-version']); } catch (error) { blockers.push(error.message); } }
  blockers.push(...providerBlockers(settings));
  if (evidence.project && !evidence.project.error) {
    const imageBlocker = keyframeOutputBlocker(evidence.project);
    if (imageBlocker) blockers.push(imageBlocker);
  }
  if (evidence.video?.video_generation_enabled !== true) blockers.push(...(evidence.video?.missing_components || ['Video unavailable']));
  if (activeVideoWorkflow === 'grok_imagine_browser') {
    try {
      const queue = localQueueDir('NOVASTORY_GROK_VIDEO_QUEUE_DIR', 'grok-video-jobs');
      fs.mkdirSync(queue, { recursive: true });
      fs.accessSync(queue, fs.constants.W_OK);
      evidence.grok_video_queue = { status: 'queue_writable', queue };
    } catch (error) {
      blockers.push(`grok video queue: ${error.message}`);
    }
  }
  state.preflight = { checkedAt: new Date().toISOString(), blockers }; save();
  if (blockers.length) throw new Error(blockers.join('\n'));
  return evidence;
}
async function text() {
  const project = await request(`/projects/${projectId}`);
  let existingPlan;
  try { existingPlan = await plan(); }
  catch (error) {
    if (error.status !== 404 || error.code !== 'PLAN_NOT_FOUND') throw error;
    existingPlan = await request(`/projects/${projectId}/story-plan/bootstrap`, 'POST', {});
  }
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
  const placeholders = active.filter(e => !e.summary?.trim());
  if (placeholders.length) await applyPlanCandidate('revise-placeholder', { kind: 'chapters', mode: 'revise', target_plan_ids: placeholders.map(e => e.id), message: `${brief} 将空白规划改为明确的开场、危机与转机。` });
  for (let guard = 0; guard < 40 && (await plan()).entries.filter(e => e.disposition === 'active').length < chapterLimit; guard++) {
    const current = await plan();
    const count = current.entries.filter(e => e.disposition === 'active').length;
    const missing = chapterLimit - count;
    if (missing <= 0) break;
    await applyPlanCandidate(`plan-extend-${count}`, { kind: 'chapters', mode: 'extend', batch_size: Math.min(5, missing), message: `${brief} 补齐共${chapterLimit}章的规划。每一章都有因果，最后一章解决本次危机。` });
    const grown = (await plan()).entries.filter(e => e.disposition === 'active').length;
    if (grown <= count) throw new Error(`Story plan stayed at ${count} active chapters`);
  }
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
      await request(`/chapters/${chapter.id}`, 'PATCH', { content: draft.content });
    }
    const latest = (await chapters())[i];
    if (latest.status !== 'completed' || latest.finalized_content_hash !== hash(latest.content)) {
      await request('/agent/impact', 'POST', { project_id: projectId, chapter_id: latest.id, apply: true });
    }
    write(`03-chapter-${i + 1}.txt`, (await chapters())[i].content);
  }
  await requireContinuityReview();
}
async function continuityReport() {
  const source = (await chapters()).map(chapter => ({ id: chapter.id, content: chapter.content }));
  const sourceFingerprint = fingerprint(source);
  const report = await step(`continuity-review:${sourceFingerprint.slice(0, 16)}`, () => request('/agent/consistency', 'POST', { project_id: projectId }));
  const reviewFingerprint = fingerprint({ sourceFingerprint, issues: report.issues });
  write('04-continuity-review.json', { ...report, review_fingerprint: reviewFingerprint });
  return { report, fingerprint: reviewFingerprint };
}
async function requireContinuityReview() {
  const current = await continuityReport();
  if (!Array.isArray(current.report.issues)) throw new Error('Continuity report has no issues array');
  if (current.report.issues.length && (state.continuityReview?.fingerprint !== current.fingerprint || state.continuityReview?.status !== 'approved')) {
    throw new Error(`Continuity issues need disposition before production; see 04-continuity-review.json. After resolving or documenting each issue, use --stage review-continuity --reviewer NAME --review-fingerprint ${current.fingerprint} --review-note RESOLUTION`);
  }
}
async function recordContinuityReview() {
  const current = await continuityReport();
  const reviewer = option('reviewer', '').trim();
  const expected = option('review-fingerprint', '');
  const note = option('review-note', '').trim();
  if (!reviewer || !note || expected !== current.fingerprint) throw new Error('Continuity disposition requires --reviewer, --review-note and the current report fingerprint');
  state.continuityReview = { status: 'approved', reviewer, reviewed_at: new Date().toISOString(), fingerprint: current.fingerprint, note, issues: current.report.issues };
  save();
}
async function legacyTaskOrderEvidence() {
  const tracked = new Set((state.taskSubmissions || []).map(item => item.submission_step));
  const untracked = Object.entries(state.steps)
    .filter(([name]) => /^(shot-|library-|character-).*:submit$/.test(name) && !tracked.has(name))
    .map(([name, entry]) => ({ step: name, started_at: entry.startedAt || null, completed_at: entry.completedAt || null, status: entry.status }));
  const approvals = (await chapters()).map(chapter => ({ chapter_id: chapter.id, index: chapter.index,
    image_review: state.reviews?.images?.[chapter.id] || null,
    chapter_review: state.reviews?.chapters?.[chapter.id] || null }));
  const snapshot = { untracked, approvals };
  const digest = fingerprint(snapshot);
  write('legacy-task-order.json', { fingerprint: digest, snapshot });
  return { fingerprint: digest, untracked };
}
async function recordLegacyTaskOrderReview() {
  const evidence = await legacyTaskOrderEvidence();
  const reviewer = option('reviewer', '').trim(), note = option('review-note', '').trim();
  if (!evidence.untracked.length) throw new Error('No legacy task submissions need review');
  if (!reviewer || !note || option('review-fingerprint', '') !== evidence.fingerprint) {
    throw new Error('Legacy task order review requires --reviewer, --review-note and the current legacy-task-order.json fingerprint');
  }
  state.legacyTaskOrderReview = { status: 'approved', reviewer, reviewed_at: new Date().toISOString(), fingerprint: evidence.fingerprint, note };
  save();
}
async function scripts(selected = null) {
  for (const chapter of selected || await chapters()) {
    let script = (await request(`/chapters/${chapter.id}/script`, 'POST', {})).script;
    const missingOutline = !script.document.scenes.length && !(script.document.outline?.beats?.length);
    if (rebuildScripts || missingOutline) {
      const name = `script-${script.id}:outline-compact${scriptRebuildToken}`;
      const candidate = await step(`${name}:candidate`, () => request(`/scripts/${script.id}/candidates`, 'POST', {
        kind: 'outline', expected_revision: script.revision, request_key: key(`${name}:v1`),
        instructions: '按本章正文写出戏剧节拍。每个节拍对应一个分场，不是镜头。节拍概括一组连续事件，不写机位、秒数或对白。mustKeepEvents只保留可表演的核心事件，并覆盖起因、冲突、关键选择与结尾。地点和人物名称沿用原文，不要加入原文没有的事件。',
      }).then(result => result.candidate));
      const compact = JSON.parse(candidate.after_json);
      if (!compact.beats?.length) throw new Error(`Script ${script.id} outline has no beats`);
      script = (await step(`${name}:apply`, () => request(`/scripts/${script.id}/candidates/${candidate.id}/apply`, 'POST', {
        expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision, request_key: key(`apply-${candidate.id}`),
      }))).script;
    }
    if (rebuildScripts || !script.document.scenes.length) {
      const kind = 'script';
      const name = `script-${script.id}:${kind}${scriptRebuildToken}`;
      const requestName = scriptRebuildToken ? `${name}-r${script.revision}-v2` : `script-${script.id}-${kind}-r${script.revision}-v2`;
      const candidate = await step(`${name}:candidate`, () => request(`/scripts/${script.id}/candidates`, 'POST', {
        kind, expected_revision: script.revision, request_key: key(requestName),
        instructions: '按已采纳的节拍改编成分场剧本。每个必保事件必须写进实际表演块，先保留事件原句，再补充可见动作和对白。不能只在 coveredEventIds 里声称覆盖。场景与道具名称沿用原文和资产库，不要增加原文没有的情节。',
      }).then(result => result.candidate));
      script = (await step(`${name}:apply`, () => request(`/scripts/${script.id}/candidates/${candidate.id}/apply`, 'POST', {
        expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision, request_key: key(`apply-${candidate.id}`),
      }))).script;
    }
    if (script.status !== 'confirmed') script = (await request(`/scripts/${script.id}/confirm`, 'POST', { expected_revision: script.revision, request_key: key(`confirm-${script.id}-${script.revision}`) })).script;
    write(`05-script-${chapter.index}.json`, script);
    const exported = await request(`/scripts/${script.id}/export`); write(`05-script-${chapter.index}.txt`, exported.markdown);
  }
}
async function assertComfyImages() {
  const imageBlocker = keyframeOutputBlocker(await request(`/projects/${projectId}`));
  if (imageBlocker) throw new Error(imageBlocker);
  const settings = await request('/settings/');
  const blockers = providerBlockers(settings).filter(item => item.startsWith('生图和生视频'));
  if (allowCodexImage) {
    const codexBlocker = providerBlockers(settings).find(item => item.startsWith('--allow-codex-image'));
    if (codexBlocker) throw new Error(codexBlocker);
    return;
  }
  if (blockers.length) throw new Error(blockers.join('\n'));
}
async function assets(selected = null) {
  await assertComfyImages();
  const scope = selected || await chapters();
  for (const chapter of scope) await step(`extract-assets:${chapter.id}:${hash(chapter.content || '').slice(0, 12)}`, () => request('/asset-library/extract', 'POST', { chapter_id: chapter.id }));
  const knownCharacters = await characters();
  const storyboardShots = await selectedShots(scope);
  const visibleIds = new Set();
  for (const shot of storyboardShots) {
    for (const character of resolveVisibleShotCast(shot, knownCharacters)) visibleIds.add(character.id);
    const primary = resolveShotCharacter(shot, knownCharacters);
    if (primary) visibleIds.add(primary.id);
  }
  for (let character of knownCharacters.filter(character => visibleIds.has(character.id))) {
    for (const type of ['portrait', 'turnaround']) {
      const slot = type === 'portrait' ? 'avatar_url' : 'turnaround_url';
      const rebuildSlot = `${assetRebuildToken}:character:${character.id}:${type}`;
      let fileExists = false; try { fileExists = fs.existsSync(localMedia(character[slot])); } catch {}
      if (fileExists && (!rebuildAssets || (retryFailed && state.rebuiltAssets?.[rebuildSlot] === character[slot]))) continue;
      const visualDescription = character.visual_tags?.visual_bible?.portrait_description || character.description;
      const referenceUrl = type === 'portrait' ? character.visual_tags?.visual_bible?.reference_image_url : character.avatar_url;
      const promptInput = { gen_type: type, custom_description: visualDescription, use_ref_portrait: !!referenceUrl, ref_image_url: referenceUrl || undefined };
      const promptSignature = hash(JSON.stringify({ promptInput, version: character.active_version, settings: await request(`/projects/${projectId}`) })).slice(0, 16);
      const prompt = await step(`character-${character.id}:${type}:prompt:${promptSignature}${assetRebuildToken}`, () => request(`/characters/${character.id}/build-prompt`, 'POST', promptInput));
      const task = await generateImage(`character-${character.id}:${type}:${promptSignature}${assetRebuildToken}`, requestKey => request('/assets/generate', 'POST', {
        scene_id: 90_000_000 + character.id, request_key: requestKey, workflow: { ...prompt, character_id: character.id, gen_type: type, character_ref_url: referenceUrl || undefined, ref_image_url: referenceUrl || undefined, reference_tier: 'A' },
      }));
      character = await request(`/characters/${character.id}`, 'PUT', { [slot]: task.image_url });
      if (rebuildAssets) { state.rebuiltAssets ||= {}; state.rebuiltAssets[rebuildSlot] = task.image_url; save(); }
    }
  }
  const allAssets = await library();
  const ids = new Set();
  if (assetScope === 'all') {
    for (const asset of allAssets) {
      if (scope.some(chapter => mentionsChapter(asset, chapter.id))) ids.add(asset.id);
    }
  }
  for (const shot of storyboardShots) {
    const binding = resolveAssetBindings(shot, allAssets);
    if (binding.blockers.length) throw new Error(`Shot ${shot.id}: ${binding.blockers.join('; ')}`);
    binding.asset_ids.forEach(id => ids.add(id));
  }
  const selectedAssets = allAssets.filter(asset => ids.has(asset.id));
  for (const asset of selectedAssets) {
    const rebuildSlot = `${assetRebuildToken}:library:${asset.id}`;
    let fileExists = false; try { fileExists = fs.existsSync(localMedia(asset.image_url)); } catch {}
    if (rebuildAssets && retryFailed && fileExists && state.rebuiltAssets?.[rebuildSlot] === asset.image_url) continue;
    if (!rebuildAssets && asset.status === 'generating' && asset.task_id) await waitTask(asset.task_id);
    else if (rebuildAssets || asset.status !== 'completed' || !fileExists) {
      const task = await generateImage(`library-${asset.id}:v${asset.revision}${assetRebuildToken}`, () => request(`/asset-library/${asset.id}/generate`, 'POST', {}));
      if (rebuildAssets) { state.rebuiltAssets ||= {}; state.rebuiltAssets[rebuildSlot] = task.image_url; save(); }
    }
  }
  write('06-characters.json', await characters()); write('06-asset-library.json', await library());
}
async function storyboards(selected = null) {
  const [project, system] = await Promise.all([request(`/projects/${projectId}`), request('/settings/')]);
  const policy = fingerprint({ nsfw_mode: projectSettingsOf(project).image_generation?.nsfw_mode || 'inherit', system_nsfw: Boolean(system.advanced?.nsfw_enabled), llm: system.llm, visual_prompt_policy_version: 1 });
  for (const chapter of selected || await chapters()) {
    const existing = await request(`/timeline/${chapter.id}`);
    const script = (await request(`/chapters/${chapter.id}/script`)).script;
    if (script.status !== 'confirmed' || script.freshness?.sourceChanged) throw new Error(`Script ${script.id} must be confirmed and current`);
    if (existing.timeline.length) {
      const current = existing.timeline.every(shot => {
        const source = (typeof shot.shot_spec === 'string' ? JSON.parse(shot.shot_spec) : shot.shot_spec)?.source;
        return source?.type === 'script' && source.script_id === script.id && source.script_revision === script.revision;
      });
      const previousPolicy = state.storyboardInputs?.[chapter.id];
      if (current && !rebuildStoryboards && !previousPolicy) {
        if (!acceptLegacyStoryboards) throw new Error(`Storyboard ${chapter.id}: generation content policy is unknown; use --rebuild-storyboards after archiving accepted video candidates, or inspect it and explicitly pass --accept-legacy-storyboards`);
        console.log(`REUSE storyboard ${chapter.id}: legacy policy remains unknown by explicit operator choice`);
        continue;
      }
      if (current && !rebuildStoryboards && previousPolicy === policy) continue;
      if (!rebuildStoryboards) throw new Error(`Script ${script.id}: storyboard source or content policy changed; review and run --rebuild-storyboards to retain a snapshot and replace it`);
      const readyFinals = [];
      for (const shot of existing.timeline) {
        const media = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
        for (const asset of media.assets || []) {
          if (asset.role === 'narrative_final' && asset.status === 'ready') readyFinals.push(asset.id);
        }
      }
      if (readyFinals.length) throw new Error(`Chapter ${chapter.id} has accepted narrative_final assets (${readyFinals.join(', ')}). Archive these candidates in Director to keep their files and history, then rerun --rebuild-storyboards.`);
    }
    const name = `storyboard-${script.id}:revision-${script.revision}:policy-${policy.slice(0, 12)}${storyboardRebuildToken}`;
    const candidate = await step(`${name}:candidate`, () => request(`/scripts/${script.id}/storyboard-candidates`, 'POST', {
      expected_revision: script.revision, request_key: key(name), instructions: '按已确认剧本生成本章分镜。每镜只有一个地点和一个连续动作，默认每镜5秒。覆盖每一场以及全部对白和旁白块，每块只分配一次并保持时序。地点和道具使用资产库中的稳定名称，不要把不同地点并进同一镜，也不要加入剧本没有的动作或角色。',
    }).then(result => result.candidate));
    await step(`${name}:apply`, () => request(`/scripts/${script.id}/storyboard-candidates/${candidate.id}/apply`, 'POST', {
      expected_revision: candidate.base_revision, expected_candidate_revision: candidate.candidate_revision, request_key: key(`apply-${candidate.id}`),
      ...(existing.timeline.length ? { replace_existing: true, expected_scene_ids: existing.timeline.map(shot => shot.id) } : {}),
    }));
    state.storyboardInputs ||= {}; state.storyboardInputs[chapter.id] = policy; save();
  }
  write('07-storyboards.json', await shots());
}
async function images(selected = null) {
  await assertComfyImages();
  const allAssets = await library();
  let knownCharacters;
  const snapshots = (await request(`/projects/${projectId}/export`)).asset_library?.image_snapshots || [];
  const imageSettings = projectSettingsOf(await request(`/projects/${projectId}`));
  const systemSettings = await request('/settings/');
  for (const shot of await selectedShots(selected)) {
    const existing = await request(`/timeline/scenes/${shot.id}/asset-references`);
    const binding = resolveAssetBindings(shot, allAssets, existing);
    if (binding.blockers.length) throw new Error(`Shot ${shot.id}: ${binding.blockers.join('; ')}; bind every required asset in Director and resume`);
    const refs = existing.length ? existing : await request(`/timeline/scenes/${shot.id}/asset-references`, 'PUT', { asset_ids: binding.asset_ids });
    if (refs.some(r => r.stale)) throw new Error(`Shot ${shot.id} has stale asset references`);
    knownCharacters ||= await characters();
    const visibleCharacters = resolveVisibleShotCharacters(shot, knownCharacters);
    const visibleCast = resolveVisibleShotCast(shot, knownCharacters);
    const signature = fingerprint({ contract: shotContract(shot), settings: imageSettings, system: { image_provider: systemSettings.image_provider, image_generation: systemSettings.image_generation, advanced: systemSettings.advanced, comfyui: systemSettings.comfyui }, refs: refs.map(r => ({ id: r.id, revision: r.revision, image: r.image_url ? { url: r.image_url, sha256: fileHash(localMedia(r.image_url)) } : null })), cast: visibleCast.map(c => ({ id: c.id, version: c.active_version || 1, visual_tags: c.visual_tags, avatar: c.avatar_url ? { url: c.avatar_url, sha256: fileHash(localMedia(c.avatar_url)) } : null })) });
    const recorded = state.imageInputs?.[shot.id];
    let currentImageHash;
    try { currentImageHash = fileHash(localMedia(shot.asset_url)); } catch {}
    if (shot.asset_status !== 'completed' || !shot.asset_url
      || recorded?.signature !== signature || recorded?.url !== shot.asset_url || !currentImageHash || recorded?.sha256 !== currentImageHash
      || !keyframeUsesBindings(shot, refs, snapshots)
      || !keyframeUsesCharacterVersions(shot, knownCharacters, snapshots, visibleCast.map(character => character.id))) {
      const primary = resolveShotCharacter(shot, knownCharacters);
      const task = await generateImage(`shot-${shot.id}:image:${signature.slice(0, 16)}`, requestKey => request('/assets/generate', 'POST', { scene_id: shot.id, request_key: requestKey, workflow: { gen_type: 'scene', character_ref_url: primary?.avatar_url || undefined, character_ref_urls: visibleCharacters.map(c => c.avatar_url), shot_master_character_ids: visibleCast.map(c => c.id) } }));
      state.imageInputs ||= {}; state.imageInputs[shot.id] = { signature, url: task.image_url, sha256: hash(fs.readFileSync(localMedia(task.image_url))) }; save();
    }
  }
  write('08-rendered-storyboards.json', await shots());
}
async function assertComfyVideo() {
  await projectVideoDefault();
  const blockers = [];
  if (process.env.NOVASTORY_VIDEO_WORKFLOW === 'grok_imagine_browser' && !allowGrokVideo) {
    blockers.push('NOVASTORY_VIDEO_WORKFLOW=grok_imagine_browser 不会自动生效。只有明确要求时才传入 --video-workflow grok_imagine_browser。');
  }
  if (projectRequestsGrokVideo && !allowGrokVideo) {
    blockers.push('项目 video_generation.workflow_id 是 grok_imagine_browser。默认制作改用 ComfyUI；只有明确要求时才传入 --video-workflow grok_imagine_browser。');
  }
  if (blockers.length) throw new Error(blockers.join('\n'));
}
async function videoPreflight(selected = null) {
  await assertComfyVideo();
  const known = await characters();
  const results = [];
  for (const shot of await selectedShots(selected)) {
    const media = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
    const primary = resolveShotCharacter(shot, known);
    const strategy = chooseShotVideoStrategy(media.assets || [], workflowOverride, await projectVideoDefault());
    const references = (media.assets || []).filter(asset => asset.role === 'character_reference' && asset.status === 'ready' && asset.character_id === primary?.id).slice(-2).map(asset => asset.id);
    const body = { scene_id: shot.id, scene_version: shot.active_version || 1, ...strategy, profile: 'narrative_clip', preset: 'standard_720p_5s', character_reference_asset_ids: strategy.workflow_id === 'minimax_h3_fl2va_official_12gb' ? [] : references, run_loop_closer: false };
    const check = await request('/videos/preflight', 'POST', body);
    const identityReady = !primary || strategy.workflow_id === 'minimax_h3_fl2va_official_12gb' || references.length > 0;
    results.push({ scene_id: shot.id, chapter_id: shot.chapter_id, workflow_id: strategy.workflow_id, workflow_reason: strategy.reason, keyframe_ready: shot.asset_status === 'completed' && !!shot.asset_url, character_id: primary?.id || null, reference_asset_ids: references, ...check, identity_ready: identityReady, ready: check.ready && identityReady });
  }
  const evidenceFile = path.join(directory, '09-video-preflight.json');
  let merged = results;
  if (selected && fs.existsSync(evidenceFile)) {
    try {
      const prior = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).results || [];
      const ids = new Set(results.map(result => result.scene_id));
      merged = [...prior.filter(result => !ids.has(result.scene_id)), ...results];
    } catch { merged = results; }
  }
  const currentIds = new Set((await shots()).map(shot => shot.id));
  merged = merged.filter(result => currentIds.has(result.scene_id));
  write('09-video-preflight.json', { chapterLimit, workflow, results: merged });
  if (results.some(result => !result.keyframe_ready || !result.ready)) throw new Error('Some selected shots are not ready for video generation; see 09-video-preflight.json');
  return results;
}
async function videos(selected = null) {
  await assertComfyVideo();
  const pendingReview = [];
  for (const shot of await selectedShots(selected)) {
    const available = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
    const known = await characters();
    const refs = (available.assets || []).filter(a => a.role === 'character_reference' && a.character_id != null && a.status === 'ready');
    const primary = resolveShotCharacter(shot, known);
    const selectedRefs = primary ? refs.filter(a => a.character_id === primary.id).slice(-2).map(a => a.id) : [];
    const strategy = chooseShotVideoStrategy(available.assets || [], workflowOverride, await projectVideoDefault());
    if (primary && !selectedRefs.length && strategy.workflow_id !== 'minimax_h3_fl2va_official_12gb') throw new Error(`Shot ${shot.id}: missing generated identity references for ${primary.name}`);
    const parameters = { scene_id: shot.id, scene_version: shot.active_version || 1, ...strategy, profile: 'narrative_clip', preset: 'standard_720p_5s', character_reference_asset_ids: strategy.workflow_id === 'minimax_h3_fl2va_official_12gb' ? [] : selectedRefs, run_loop_closer: false };
    const flight = await request('/videos/preflight', 'POST', parameters); write(`preflight-shot-${shot.id}.json`, flight);
    if (!flight.ready) throw new Error(`Shot ${shot.id}: ${(flight.blockers || []).join('; ')}`);
    const readyVideo = (available.assets || []).filter(a => a.role === 'narrative_final' && a.status === 'ready').at(-1);
    let invalidFinal = false;
    if (readyVideo) {
      const provenance = videoProvenance(shot, available.assets, known);
      try { const file = localMedia(readyVideo.url); invalidFinal = !readyVideo.sha256 || readyVideo.sha256 !== fileHash(file); assertChapterClipReady(probe(file), `Shot ${shot.id}`); }
      catch { invalidFinal = true; }
      if (!invalidFinal && provenance.source_current && provenance.identity_current && flight.input_signature && provenance.input_signature === flight.input_signature) continue;
    }
    const signature = fingerprint({ parameters, source: shotContract(shot), keyframe: shot.asset_url, input_signature: flight.input_signature }).slice(0, 16);
    const name = `shot-${shot.id}:video:${signature}`;
    if (retryFailed && state.steps[name]?.status === 'completed') { delete state.steps[name]; save(); }
    await step(name, async () => {
      const submittedKey = `${name}:submit`;
      const cached = state.steps[submittedKey]?.result;
      if (cached && retryFailed) {
        const task = await request(`/videos/tasks/${cached.task_id}`);
        if (['failed', 'cancelled', 'interrupted', 'rejected'].includes(task.status) || (task.status === 'completed' && invalidFinal)) {
          delete state.steps[submittedKey]; state.videoAttempts ||= {}; state.videoAttempts[shot.id] = (state.videoAttempts[shot.id] || 0) + 1; save();
        }
      }
      const body = { ...parameters, ...(flight.input_signature ? { expected_input_signature: flight.input_signature } : {}),
        request_key: key(`${name}-attempt-${state.videoAttempts?.[shot.id] || 0}`) };
      const submitted = await step(submittedKey, () => submitProductionTask('video', submittedKey, () => request('/videos/generate', 'POST', body)));
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
      input_signature: generation.input_signature,
      identity_current: !primary || generation.workflow_id === 'minimax_h3_fl2va_official_12gb'
        || (referenceIds.length > 0 && references.length === referenceIds.length && references.every(a => a.role === 'character_reference' && a.status === 'ready' && a.character_id === primary.id)),
      source_current: generation.scene_id === shot.id && generation.scene_version === (shot.active_version || 1) && keyframe?.url === shot.asset_url,
    };
  } catch (error) { return { scene_id: shot.id, character_id: primary?.id || null, identity_current: false, source_current: false, error: error.message }; }
}
function command(binary, arguments_) {
  const result = spawnSync(binary, arguments_, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary}: ${(result.stderr || result.error?.message || '').slice(-2500)}`);
  return result.stdout;
}
const probe = file => JSON.parse(command('ffprobe', ['-v', 'error', '-count_frames', '-show_format', '-show_streams', '-of', 'json', file]));
const fileHash = file => hash(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function decode(file) { command('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-map', '0:v?', '-map', '0:a?', '-f', 'null', '-']); }
async function chapterSnapshot(chapter, includeVideos = false) {
  const [project, system, result, scriptResult, known, assets] = await Promise.all([
    request(`/projects/${projectId}`), request('/settings/'), request(`/timeline/${chapter.id}`), request(`/chapters/${chapter.id}/script`), characters(), library(),
  ]);
  const timeline = result.timeline;
  const script = scriptResult.script;
  const errors = validateScriptCoverage(script, timeline);
  if (errors.length) throw new Error(errors.join('; '));
  const speechBlocks = script.document.scenes.flatMap(scene => scene.blocks.filter(block => ['dialogue', 'voiceover'].includes(block.type)));
  const needsDefault = speechBlocks.some(block => !(block.type === 'voiceover' && narratorVoice) && !known.find(character => character.id === block.characterId)?.voice_id);
  const speechStatus = needsDefault ? await request('/tts/status') : null;
  if (needsDefault && (!speechStatus.ok || !speechStatus.default_voice)) throw new Error('Local speech service has no available default voice');
  const voices = speechBlocks.map(block => ({ block_id: block.id, voice_id: block.type === 'voiceover' && narratorVoice ? narratorVoice : known.find(character => character.id === block.characterId)?.voice_id || speechStatus?.default_voice }));
  const referencedCharacters = new Set(timeline.flatMap(shot => resolveVisibleShotCast(shot, known).map(character => character.id)));
  const referencedAssets = new Set();
  const frames = [];
  for (const shot of timeline) {
    if (shot.asset_status !== 'completed') throw new Error(`Shot ${shot.id}: image is incomplete`);
    const file = localMedia(shot.asset_url), info = probe(file), stream = info.streams.find(stream => stream.codec_type === 'video');
    if (!stream || stream.width < 1280 || stream.height < 720 || Math.abs(stream.width / stream.height - 16 / 9) > 0.02) throw new Error(`Shot ${shot.id}: keyframe must be at least 1280×720 and 16:9`);
    decode(file);
    const refs = await request(`/timeline/scenes/${shot.id}/asset-references`);
    const binding = resolveAssetBindings(shot, assets, refs);
    if (binding.blockers.length || refs.some(ref => ref.stale)) throw new Error(`Shot ${shot.id}: asset bindings are stale or incomplete`);
    binding.asset_ids.forEach(id => referencedAssets.add(id));
    const frame = { contract: shotContract(shot), image: { url: shot.asset_url, sha256: fileHash(file) }, references: refs.map(ref => ({ id: ref.id, revision: ref.asset_revision ?? ref.revision, image_url: ref.image_url })) };
    if (includeVideos) {
      const media = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
      const final = media.assets.filter(asset => asset.role === 'narrative_final' && asset.status === 'ready').at(-1);
      if (!final) throw new Error(`Shot ${shot.id}: final video has not been accepted`);
      const provenance = videoProvenance(shot, media.assets, known);
      const strategy = chooseShotVideoStrategy(media.assets, workflowOverride, await projectVideoDefault());
      const primary = resolveShotCharacter(shot, known);
      const refs = media.assets.filter(asset => asset.role === 'character_reference' && asset.status === 'ready' && asset.character_id === primary?.id).slice(-2).map(asset => asset.id);
      const flight = await request('/videos/preflight', 'POST', { scene_id: shot.id, scene_version: shot.active_version || 1, ...strategy, profile: 'narrative_clip', preset: 'standard_720p_5s', character_reference_asset_ids: strategy.workflow_id === 'minimax_h3_fl2va_official_12gb' ? [] : refs, run_loop_closer: false });
      if (!flight.ready || !flight.input_signature || provenance.input_signature !== flight.input_signature || !provenance.source_current || !provenance.identity_current) throw new Error(`Shot ${shot.id}: final video inputs changed; regenerate and review`);
      const file = localMedia(final.url); assertChapterClipReady(probe(file), `Shot ${shot.id}`); decode(file);
      if (!final.sha256 || final.sha256 !== fileHash(file)) throw new Error(`Shot ${shot.id}: final video bytes changed since QA`);
      frame.video = { id: final.id, url: final.url, sha256: fileHash(file), input_signature: provenance.input_signature };
    }
    frames.push(frame);
  }
  const mediaCharacter = character => ({ id: character.id, version: character.active_version || 1, voice_id: character.voice_id || null, images: [character.avatar_url, character.turnaround_url].filter(Boolean).map(url => ({ url, sha256: fileHash(localMedia(url)) })) });
  return { schema_version: 1, project_id: projectId, chapter_id: chapter.id, content_hash: hash(chapter.content || ''), settings: projectSettingsOf(project), system: { image_provider: system.image_provider, image_generation: system.image_generation, advanced: system.advanced, comfyui: system.comfyui, tts: system.tts, video_generation: system.video_generation }, narrator_voice: narratorVoice, voices, script: { id: script.id, revision: script.revision, document: script.document }, characters: known.filter(character => referencedCharacters.has(character.id) || script.document.scenes.some(scene => scene.blocks.some(block => block.characterId === character.id))).map(mediaCharacter), assets: assets.filter(asset => referencedAssets.has(asset.id)).map(asset => ({ id: asset.id, revision: asset.revision, url: asset.image_url, sha256: fileHash(localMedia(asset.image_url)) })), frames };
}
function reviewPreview(chapter, kind, snapshot) {
  migrateReviewFingerprint(chapter, kind, snapshot);
  const digest = fingerprint(snapshot);
  const name = `${kind}-chapter-${chapter.id}`;
  write(`${name}.json`, { fingerprint: digest, snapshot });
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const media = kind === 'review-images' ? snapshot.frames.map(frame => `<figure><img width="640" src="${escape(pathToFileURL(localMedia(frame.image.url)).href)}"><figcaption>镜头 ${frame.contract.id}</figcaption></figure>`).join('') : `<video controls width="960" src="${escape(pathToFileURL(snapshot.delivery.file).href)}"></video>`;
  write(`${name}.html`, `<!doctype html><meta charset="utf-8"><title>章节验收</title><h1>第${chapter.index}章 · ${kind === 'review-images' ? '分镜图片' : '完整成片'}验收</h1><p>检查人物、服装、场景道具、动作连续性${kind === 'review-chapter' ? '、完整对白旁白、音效、字幕及口型' : ''}。</p>${media}<p>看完并通过后，用本页指纹记录审核人；来源变化后需重新验收。</p><pre>--stage ${kind} --chapter-id ${escape(chapter.id)} --reviewer 审核人 --review-fingerprint ${digest}</pre>`);
  return digest;
}
function canonicalReviewSnapshot(snapshot) {
  if (snapshot?.source && snapshot?.delivery) {
    const source = canonicalReviewSnapshot(snapshot.source);
    return { ...snapshot, source, delivery: { ...snapshot.delivery, source_fingerprint: fingerprint(source) } };
  }
  return { ...snapshot, frames: snapshot.frames.map(frame => ({ ...frame, references: frame.references.map(ref => ({ id: ref.id, revision: ref.asset_revision ?? ref.revision, image_url: ref.image_url })) })) };
}
function migrateReviewFingerprint(chapter, kind, snapshot) {
  const review = state.reviews?.[kind === 'review-images' ? 'images' : 'chapters']?.[chapter.id];
  const file = path.join(directory, `${kind}-chapter-${chapter.id}.json`);
  if (!review || !fs.existsSync(file)) return;
  const previous = readJson(file);
  if (review.fingerprint !== previous.fingerprint || fingerprint(previous.snapshot) !== previous.fingerprint) return;
  if (fingerprint(canonicalReviewSnapshot(previous.snapshot)) !== fingerprint(snapshot)) return;
  review.fingerprint = fingerprint(snapshot);
  save();
}
async function requireImageReview(chapter) {
  const snapshot = await chapterSnapshot(chapter);
  reviewPreview(chapter, 'review-images', snapshot);
  assertReview(state.reviews?.images?.[chapter.id], snapshot, `Chapter ${chapter.index} images`);
}
async function chapterDeliverySnapshot(chapter) {
  const source = await chapterSnapshot(chapter, true);
  const manifest = readJson(path.join(directory, 'videos', `chapter-${chapter.index}.manifest.json`));
  if (manifest.source_fingerprint !== fingerprint(source)) {
    const previousFile = path.join(directory, `review-chapter-chapter-${chapter.id}.json`);
    if (fs.existsSync(previousFile)) {
      const previous = readJson(previousFile);
      if (previous.snapshot?.source && fingerprint(previous.snapshot.source) === manifest.source_fingerprint
        && fingerprint(canonicalReviewSnapshot(previous.snapshot.source)) === fingerprint(source)) {
        manifest.source_fingerprint = fingerprint(source);
        write(`videos/chapter-${chapter.index}.manifest.json`, manifest);
      }
    }
  }
  if (manifest.source_fingerprint !== fingerprint(source)) throw new Error(`Chapter ${chapter.index}: composition sources changed; reassemble`);
  if (fileHash(manifest.file) !== manifest.sha256 || fileHash(manifest.subtitle_file) !== manifest.subtitle_sha256 || manifest.speech_files.some(item => fileHash(localMedia(item.url)) !== item.sha256)) throw new Error(`Chapter ${chapter.index}: delivery or speech files changed; reassemble`);
  return { source, delivery: manifest };
}
async function requireChapterReview(chapter) {
  const snapshot = await chapterDeliverySnapshot(chapter);
  reviewPreview(chapter, 'review-chapter', snapshot);
  assertReview(state.reviews?.chapters?.[chapter.id], snapshot, `Chapter ${chapter.index} chapter_ready`);
}
async function assertPriorChaptersReady(chapter, scope = null) {
  for (const prior of (scope || await chapters()).filter(item => item.index < chapter.index)) {
    await requireImageReview(prior);
    await requireChapterReview(prior);
  }
}
async function runChapterProductionStage(handler, selected = null) {
  const scope = await chapters();
  for (const chapter of selected || scope) {
    await assertPriorChaptersReady(chapter, scope);
    await requireContinuityReview();
    activeProductionChapterId = chapter.id;
    try { await handler([chapter]); }
    finally { activeProductionChapterId = null; }
  }
}
async function recordReview(kind) {
  const reviewer = option('reviewer', '').trim(), expected = option('review-fingerprint', '');
  if (!selectedChapterId || !reviewer || !expected) throw new Error('Review requires --chapter-id, --reviewer and the fingerprint from the current preview');
  const chapter = (await chapters()).find(chapter => String(chapter.id) === selectedChapterId);
  if (!chapter) throw new Error('Selected chapter is outside this production scope');
  if (kind === 'chapters') await requireImageReview(chapter);
  const snapshot = kind === 'images' ? await chapterSnapshot(chapter) : await chapterDeliverySnapshot(chapter);
  const digest = reviewPreview(chapter, kind === 'images' ? 'review-images' : 'review-chapter', snapshot);
  if (expected !== digest) throw new Error('Preview fingerprint changed; review the new preview before approving');
  state.reviews ||= {}; state.reviews[kind] ||= {};
  state.reviews[kind][chapter.id] = { status: 'approved', reviewer, reviewed_at: new Date().toISOString(), fingerprint: digest, note: option('review-note', ''), checks: kind === 'chapters' ? ['speech_complete', 'sound_effects', 'subtitles', 'lip_sync', 'visual_continuity'] : ['characters', 'locations_props', 'actions', 'continuity'] }; save();
  write('production-reviews.json', state.reviews);
}
async function audioForChapter(chapter) {
  const [result, timeline, known] = await Promise.all([request(`/chapters/${chapter.id}/script`), request(`/timeline/${chapter.id}`), characters()]);
  const script = result.script;
  const errors = validateScriptCoverage(script, timeline.timeline);
  if (errors.length) throw new Error(errors.join('; '));
  const allBlocks = timeline.timeline.flatMap(shot => spokenBlocks(script, shot));
  const status = allBlocks.length ? await request('/tts/status') : null;
  const ttsSettings = allBlocks.length ? (await request('/settings/')).tts : null;
  const needsDefault = allBlocks.some(block => !(block.type === 'voiceover' && narratorVoice) && !known.find(character => character.id === block.characterId)?.voice_id);
  if (allBlocks.length && (!status.ok || (needsDefault && !status.default_voice))) throw new Error('Local speech service has no available voice');
  const layout = {};
  for (const shot of timeline.timeline) {
    const blocks = spokenBlocks(script, shot), files = [];
    for (const block of blocks) {
      const character = known.find(character => character.id === block.characterId);
      const voice = block.type === 'voiceover' && narratorVoice ? narratorVoice : character?.voice_id || status.default_voice;
      const signature = fingerprint({ script_id: script.id, revision: script.revision, block, voice, character_version: character?.active_version || null, ttsSettings });
      const name = `speech-${signature.slice(0, 24)}`;
      const render = () => request('/tts/render-block', 'POST', { script_id: script.id, expected_revision: script.revision, block_id: block.id, voice_id: voice, request_key: key(`${name}-attempt-${state.audioAttempts?.[name] || 0}`) });
      let generated;
      try { generated = await render(); }
      catch (error) {
        if (!retryFailed || !['AUDIO_FAILED', 'AUDIO_FILE_CHANGED', 'AUDIO_INTERRUPTED'].includes(error.code)) throw error;
        state.audioAttempts ||= {}; state.audioAttempts[name] = (state.audioAttempts[name] || 0) + 1; save(); generated = await render();
      }
      const asset = generated.asset, file = localMedia(asset.url), info = probe(file);
      if (asset.status !== 'ready' || generated.source.script_id !== script.id || generated.source.script_revision !== script.revision || generated.source.block_id !== block.id || generated.source.text !== block.text.trim() || generated.source.voice_id !== voice || !info.streams.some(stream => stream.codec_type === 'audio') || asset.sha256 !== fileHash(file)) throw new Error(`Speech block ${block.id}: invalid audio or source`);
      decode(file);
      files.push({ block_id: block.id, url: asset.url, sha256: asset.sha256, duration: Number(info.format.duration), source: generated.source });
    }
    layout[shot.id] = { ...timedSpeech(blocks, files.map(file => file.duration), Math.max(5, Number(shot.duration) || 5)), files };
  }
  write(`audio-chapter-${chapter.id}.json`, layout); return layout;
}
async function audio(selected = null) { for (const chapter of selected || await chapters()) await audioForChapter(chapter); }
async function assemble(selected = null, options = {}) {
  const { shots: renderShots = true, fullFilm = true } = options;
  const scope = selected || await chapters();
  const videoDirectory = path.join(directory, 'videos'); fs.mkdirSync(videoDirectory, { recursive: true });
  const chapterFiles = [];
  const fullCues = [];
  let fullOffset = 0;
  const [known, assets, backup] = await Promise.all([characters(), library(), request(`/projects/${projectId}/export`)]);
  for (const chapter of scope) {
    const final = path.join(videoDirectory, `chapter-${chapter.index}.mp4`);
    if (renderShots && fs.existsSync(path.join(videoDirectory, `chapter-${chapter.index}.manifest.json`))) {
      try {
        const snapshot = await chapterDeliverySnapshot(chapter);
        const manifest = snapshot.delivery;
        assertChapterClipReady(probe(final), `Chapter ${chapter.index}`, { requireAudio: true, durationSeconds: manifest.duration }); decode(final);
        chapterFiles.push(final);
        fullCues.push(...manifest.cues.map(cue => ({ ...cue, start: cue.start + fullOffset, end: cue.end + fullOffset })));
        fullOffset += manifest.duration;
        continue;
      } catch (error) { console.log(`REASSEMBLE chapter ${chapter.index}: ${error.message}`); }
    }
    if (!renderShots) {
      if (!fs.existsSync(final)) throw new Error(`Missing chapter video for chapter ${chapter.index ?? chapter.id}`);
      await requireImageReview(chapter);
      await requireChapterReview(chapter);
      const manifest = readJson(path.join(videoDirectory, `chapter-${chapter.index}.manifest.json`));
      fullCues.push(...manifest.cues.map(cue => ({ ...cue, start: cue.start + fullOffset, end: cue.end + fullOffset })));
      fullOffset += manifest.duration;
      chapterFiles.push(final);
      continue;
    }
    const chapterShots = (await request(`/timeline/${chapter.id}`)).timeline;
    assertNonEmptyChapterShots(chapterShots.length, `Chapter ${chapter.index ?? chapter.id}`);
    const sourceSnapshot = await chapterSnapshot(chapter, true);
    const speech = await audioForChapter(chapter);
    const chapterClips = [];
    const chapterCues = [], speechFiles = [];
    let chapterOffset = 0;
    for (const shot of chapterShots) {
      const available = await request(`/scenes/${shot.id}/media?version=${shot.active_version || 1}`);
      const final = (available.assets || []).filter(a => a.role === 'narrative_final' && a.status === 'ready').at(-1);
      if (!final) throw new Error(`Shot ${shot.id} has no accepted final video`);
      const refs = await request(`/timeline/scenes/${shot.id}/asset-references`);
      const provenance = videoProvenance(shot, available.assets, known);
      if (!provenance.source_current || !provenance.identity_current
        || !keyframeUsesBindings(shot, refs, backup.asset_library?.image_snapshots || [])
        || !keyframeUsesCharacterVersions(shot, known, backup.asset_library?.image_snapshots || [], resolveVisibleShotCast(shot, known).map(character => character.id))
        || resolveAssetBindings(shot, assets, refs).blockers.length) throw new Error(`Shot ${shot.id} has stale or incomplete asset/video provenance; regenerate and review before assembly`);
      const source = localMedia(final.url); const info = probe(source);
      assertChapterClipReady(info, `Shot ${shot.id}`);
      const output = path.join(videoDirectory, `shot-${shot.id}.mp4`);
      const hasAudio = info.streams.some(s => s.codec_type === 'audio');
      if (shot.audio_prompt?.trim() && !hasAudio) throw new Error(`Shot ${shot.id}: script requires sound effects but the accepted source has no audio; regenerate and review its sound before assembly`);
      const layout = speech[shot.id];
      const duration = layout.duration;
      const inputs = layout.files.flatMap(file => ['-i', localMedia(file.url)]);
      const filters = layout.files.map((file, index) => `[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(layout.cues[index].start * 1000)}|${Math.round(layout.cues[index].start * 1000)}[speech${index}]`);
      const tracks = layout.files.map((_, index) => `[speech${index}]`);
      // Keep quiet native ambience under formal speech; the chapter review checks
      // overlapping native voices and lip sync before any next chapter can run.
      if (hasAudio) { filters.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${layout.files.length ? '0.12' : '1'}[native]`); tracks.push('[native]'); }
      if (tracks.length) filters.push(`${tracks.join('')}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0,volume=${tracks.length},alimiter=limit=0.95,apad,atrim=duration=${duration}[audio]`);
      else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[audio]`);
      command('ffmpeg', ['-y', '-i', source, ...inputs, '-filter_complex', filters.join(';'),
        '-map', '0:v:0', '-map', '[audio]', '-vf', `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${Math.max(0, duration - 5)}`,
        '-r', '24', '-frames:v', String(Math.round(duration * 24)), '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output]);
      assertChapterClipReady(probe(output), `Assembled shot ${shot.id}`, { requireAudio: true, durationSeconds: duration });
      decode(output);
      chapterCues.push(...layout.cues.map(cue => ({ ...cue, start: cue.start + chapterOffset, end: cue.end + chapterOffset })));
      speechFiles.push(...layout.files);
      chapterOffset += duration;
      chapterClips.push(output);
    }
    const list = path.join(videoDirectory, `chapter-${chapter.index}.concat.txt`);
    fs.writeFileSync(list, chapterClips.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
    const subtitleFile = path.join(videoDirectory, `chapter-${chapter.index}.srt`);
    fs.writeFileSync(subtitleFile, subtitles(chapterCues));
    command('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, ...(chapterCues.length ? ['-i', subtitleFile] : []), '-map', '0:v:0', '-map', '0:a:0', ...(chapterCues.length ? ['-map', '1:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho'] : []), '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', final]);
    assertChapterClipReady(probe(final), `Chapter ${chapter.index}`, { requireAudio: true, durationSeconds: chapterOffset }); decode(final);
    if (fingerprint(await chapterSnapshot(chapter, true)) !== fingerprint(sourceSnapshot)) throw new Error(`Chapter ${chapter.index}: sources changed during assembly`);
    write(`videos/chapter-${chapter.index}.manifest.json`, { schema_version: 1, source_fingerprint: fingerprint(sourceSnapshot), file: final, sha256: fileHash(final), subtitle_file: subtitleFile, subtitle_sha256: fileHash(subtitleFile), speech_files: speechFiles, cues: chapterCues, duration: chapterOffset, shot_durations: chapterShots.map(shot => ({ scene_id: shot.id, duration: speech[shot.id].duration })), created_at: new Date().toISOString() });
    fullCues.push(...chapterCues.map(cue => ({ ...cue, start: cue.start + fullOffset, end: cue.end + fullOffset }))); fullOffset += chapterOffset;
    chapterFiles.push(final);
  }
  if (!fullFilm) {
    for (const chapter of scope) reviewPreview(chapter, 'review-chapter', await chapterDeliverySnapshot(chapter));
    return chapterFiles;
  }
  for (const chapter of scope) { await requireImageReview(chapter); await requireChapterReview(chapter); }
  if (!chapterFiles.length) throw new Error('No chapters to assemble');
  const list = path.join(videoDirectory, 'full.concat.txt'); fs.writeFileSync(list, chapterFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  const final = path.join(videoDirectory, chapterLimit === 5 ? 'full-story.mp4' : `chapters-1-${chapterLimit}.mp4`);
  const subtitleFile = path.join(videoDirectory, 'full-story.srt'); fs.writeFileSync(subtitleFile, subtitles(fullCues));
  command('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, ...(fullCues.length ? ['-i', subtitleFile] : []), '-map', '0:v:0', '-map', '0:a:0', ...(fullCues.length ? ['-map', '1:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho'] : []), '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', final]);
  assertChapterClipReady(probe(final), 'Full delivery', { requireAudio: true, durationSeconds: fullOffset }); decode(final);
  write('10-video-delivery.json', { schema_version: 1, chapterLimit, chapters: chapterFiles.map((file, index) => ({ chapter_id: scope[index].id, file, sha256: fileHash(file), probe: probe(file), manifest: readJson(path.join(videoDirectory, `chapter-${scope[index].index}.manifest.json`)) })), final: { file: final, sha256: fileHash(final), duration: fullOffset, subtitle_file: subtitleFile, subtitle_sha256: fileHash(subtitleFile), probe: probe(final) } });
}
async function verify() {
  state.currentStep = 'verify'; save();
  const [cs, ps, chars, assets, ss] = await Promise.all([chapters(), plan(), characters(), library(), shots()]);
  const coreCharacterNames = new Set(ps.document.blueprint?.characters?.map(character => character.name) || []);
  const coreCharacters = chars.filter(character => coreCharacterNames.has(character.name));
  const screenplay = await Promise.all(cs.map(c => request(`/chapters/${c.id}/script`).then(r => r.script)));
  const media = await Promise.all(ss.map(s => request(`/scenes/${s.id}/media?version=${s.active_version || 1}`)));
  const requiredAssetIds = new Set(ss.flatMap(shot => resolveAssetBindings(shot, assets).asset_ids));
  if (assetScope === 'all') {
    for (const asset of assets) {
      if (cs.some(chapter => mentionsChapter(asset, chapter.id))) requiredAssetIds.add(asset.id);
    }
  }
  const requiredAssets = assets.filter(asset => requiredAssetIds.has(asset.id));
  const acceptance = [
    ['F01', `有效规划不少于${chapterLimit}章`, ps.entries.filter(e => e.disposition === 'active').length >= chapterLimit],
    ['F02', `前${chapterLimit}章正文非空且定稿哈希一致`, cs.length === chapterLimit && cs.every(c => c.content?.trim() && c.status === 'completed' && c.finalized_content_hash === hash(c.content))],
    ['F03', '章节字数达到规划的80%', cs.length === chapterLimit && cs.every(c => (c.content?.match(/[\p{L}\p{N}]/gu) || []).length >= c.target_word_count * 0.8)],
    ['F04', `前${chapterLimit}章剧本已确认且来源有效`, screenplay.length === chapterLimit && screenplay.every(s => s?.status === 'confirmed' && !s.freshness?.sourceChanged && s.document.scenes.length)],
    ['F05', '已出场的蓝图核心角色有定妆照和三视图', coreCharactersReadyForAcceptance(coreCharacterNames, coreCharacters, ss)],
    ['F06', '分镜点名的场景与道具均已生成', (() => {
      const named = ss.flatMap(shot => resolveAssetBindings(shot, assets).required || []);
      const needs = kind => named.some(item => item.kind === kind);
      return (!needs('location') || requiredAssets.some(asset => asset.kind === 'location'))
        && (!needs('prop') || requiredAssets.some(asset => asset.kind === 'prop'))
        && requiredAssets.every(asset => asset.status === 'completed' && asset.image_url);
    })()],
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
  const frameUrls = new Set(ss.map(shot => shot.asset_url));
  const imageEvidence = imageUrls.map(url => {
    try { const file = localMedia(url); const info = probe(file); decode(file); const video = info.streams.find(s => s.codec_type === 'video'); return { url, valid: frameUrls.has(url) ? video?.width >= 1280 && video?.height >= 720 && Math.abs(video.width / video.height - 16 / 9) <= 0.02 : video?.width >= 256 && video?.height >= 256, width: video?.width, height: video?.height, sha256: hash(fs.readFileSync(file)) }; }
    catch (error) { return { url, valid: false, error: error.message }; }
  });
  const shotReferences = await Promise.all(ss.map(s => request(`/timeline/scenes/${s.id}/asset-references`)));
  const backup = await request(`/projects/${projectId}/export`);
  acceptance.push({ id: 'F10', criterion: '素材和分镜图片文件存在、可解码且尺寸合格', status: imageEvidence.length > 0 && imageEvidence.every(e => e.valid) ? 'PASS' : 'FAIL' });
  const bindingEvidence = ss.map((shot, index) => ({ scene_id: shot.id, ...resolveAssetBindings(shot, assets, shotReferences[index]), keyframe_current: keyframeUsesBindings(shot, shotReferences[index], backup.asset_library?.image_snapshots || []) }));
  acceptance.push({ id: 'F11', criterion: '镜头引用与分镜所需场景道具一致且关键帧使用当前素材', status: ss.length > 0 && bindingEvidence.every(e => !e.blockers.length && e.keyframe_current) ? 'PASS' : 'FAIL' });
  let deliveryEvidence;
  try {
    const videos = cs.map(chapter => path.join(directory, 'videos', `chapter-${chapter.index}.mp4`));
    const final = path.join(directory, 'videos', chapterLimit === 5 ? 'full-story.mp4' : `chapters-1-${chapterLimit}.mp4`);
    deliveryEvidence = [...videos, final].map(file => ({ file, probe: probe(file), sha256: hash(fs.readFileSync(file)) }));
    const delivery = readJson(path.join(directory, '10-video-delivery.json'));
    for (const [index, item] of deliveryEvidence.entries()) {
      const expected = index < chapterLimit ? delivery.chapters[index].manifest.duration : delivery.final.duration;
      assertChapterClipReady(item.probe, item.file, { requireAudio: true, durationSeconds: expected }); decode(item.file);
      const digest = index < chapterLimit ? delivery.chapters[index].sha256 : delivery.final.sha256;
      if (item.sha256 !== digest) throw new Error('Delivery file changed since assembly');
    }
    if (fileHash(delivery.final.subtitle_file) !== delivery.final.subtitle_sha256) throw new Error('Final subtitles changed');
    const valid = deliveryEvidence.every(e => e.probe.streams.some(s => s.codec_type === 'video') && e.probe.streams.some(s => s.codec_type === 'audio') && Number(e.probe.format.duration) > 0);
    const expected = deliveryEvidence.slice(0, chapterLimit).reduce((sum, e) => sum + Number(e.probe.format.duration), 0);
    acceptance.push({ id: 'F12', criterion: `前${chapterLimit}章和阶段总片均可解码、含音轨且总片时长完整`, status: valid && Math.abs(Number(deliveryEvidence[chapterLimit].probe.format.duration) - expected) < 1 ? 'PASS' : 'FAIL' });
  } catch (error) { deliveryEvidence = { error: error.message }; acceptance.push({ id: 'F12', criterion: `前${chapterLimit}章和阶段总片均可解码、含音轨且总片时长完整`, status: 'FAIL' }); }
  const identityEvidence = ss.map((shot, index) => videoProvenance(shot, media[index].assets, chars));
  acceptance.push({ id: 'F13', criterion: '出场角色的身份参考有效；无人镜头无需身份参考', status: identityEvidence.length > 0 && identityEvidence.every(e => e.identity_current) ? 'PASS' : 'FAIL' });
  acceptance.push({ id: 'F14', criterion: '视频来源与当前关键帧及镜头版本一致', status: ss.length > 0 && identityEvidence.every(e => e.source_current) ? 'PASS' : 'FAIL' });
  const scriptEvidence = ss.map(shot => {
    const script = screenplay[cs.findIndex(chapter => chapter.id === shot.chapter_id)];
    let source;
    try { source = (typeof shot.shot_spec === 'string' ? JSON.parse(shot.shot_spec) : shot.shot_spec)?.source; } catch {}
    const scene = script?.document?.scenes?.find(scene => scene.id === source?.script_scene_id);
    const current = script?.status === 'confirmed' && !script.freshness?.sourceChanged && source?.type === 'script' && source.script_id === script.id && source.script_revision === script.revision && !!scene && (source.block_ids || []).every(id => scene.blocks.some(block => block.id === id));
    return { scene_id: shot.id, script_id: script?.id || null, script_revision: script?.revision || null, source: source || null, current: !!current };
  });
  const coverageEvidence = cs.map((chapter, index) => ({ chapter_id: chapter.id, errors: validateScriptCoverage(screenplay[index], ss.filter(shot => shot.chapter_id === chapter.id)) }));
  acceptance.push({ id: 'F15', criterion: '分镜完整覆盖剧本分场和原声文本，次序、次数和内容一致', status: scriptEvidence.length > 0 && scriptEvidence.every(item => item.current) && coverageEvidence.every(item => !item.errors.length) ? 'PASS' : 'FAIL' });
  const reviewEvidence = [];
  const speechEvidence = [];
  const submissionEvidence = (state.taskSubmissions || []).map(event => {
    const chapter = cs.find(item => item.id === event.chapter_id);
    const prior = chapter && cs.filter(item => item.index < chapter.index);
    const submittedAt = Date.parse(event.submitted_at);
    const ordered = !!chapter && Number.isFinite(submittedAt) && prior.every(item => {
      const approval = state.reviews?.chapters?.[item.id];
      const approvedAt = Date.parse(approval?.reviewed_at);
      return approval?.status === 'approved' && Number.isFinite(approvedAt) && approvedAt <= submittedAt;
    });
    return { ...event, ordered };
  });
  const trackedSteps = new Set(submissionEvidence.map(item => item.submission_step));
  const hasUntrackedSubmissions = Object.keys(state.steps).some(name => /^(shot-|library-|character-).*:submit$/.test(name) && !trackedSteps.has(name));
  const continuitySource = fingerprint(cs.map(chapter => ({ id: chapter.id, content: chapter.content })));
  const continuityStep = state.steps[`continuity-review:${continuitySource.slice(0, 16)}`];
  const continuityIssues = continuityStep?.result?.issues;
  const continuityFingerprint = fingerprint({ sourceFingerprint: continuitySource, issues: continuityIssues });
  const continuityCurrent = Array.isArray(continuityIssues) && (!continuityIssues.length || (state.continuityReview?.status === 'approved' && state.continuityReview?.fingerprint === continuityFingerprint));
  for (const chapter of cs) {
    try {
      await requireImageReview(chapter); await requireChapterReview(chapter);
      reviewEvidence.push({ chapter_id: chapter.id, current: true });
    } catch (error) { reviewEvidence.push({ chapter_id: chapter.id, current: false, error: error.message }); }
    try {
      const snapshot = await chapterDeliverySnapshot(chapter);
      const expected = snapshot.source.script.document.scenes.flatMap(scene => scene.blocks.filter(block => ['dialogue', 'voiceover'].includes(block.type))).map(block => ({ block_id: block.id, text: block.text.trim() }));
      const actual = snapshot.delivery.cues.map(cue => ({ block_id: cue.block_id, text: cue.text }));
      const cues = snapshot.delivery.cues;
      const current = fingerprint(expected) === fingerprint(actual) && fs.readFileSync(snapshot.delivery.subtitle_file, 'utf8') === subtitles(cues) && cues.every(cue => cue.start >= 0 && cue.end > cue.start && cue.end <= snapshot.delivery.duration) && snapshot.delivery.speech_files.length === expected.length;
      speechEvidence.push({ chapter_id: chapter.id, current, spoken_blocks: expected.length });
    } catch (error) { speechEvidence.push({ chapter_id: chapter.id, current: false, error: error.message }); }
  }
  const legacyOrder = await legacyTaskOrderEvidence();
  const legacyOrderReviewed = !hasUntrackedSubmissions || (state.legacyTaskOrderReview?.status === 'approved'
    && state.legacyTaskOrderReview?.reviewer?.trim() && state.legacyTaskOrderReview?.fingerprint === legacyOrder.fingerprint);
  acceptance.push({ id: 'F16', criterion: '连续性问题已处置；图片与章节成片已人工验收、来源未变化，制作任务符合章序或有旧记录人工核验', status: cs.length === chapterLimit && continuityCurrent && reviewEvidence.every(item => item.current) && legacyOrderReviewed && submissionEvidence.every(item => item.ordered) ? 'PASS' : 'FAIL' });
  acceptance.push({ id: 'F17', criterion: '完整对白旁白、字幕与源块逐一对应且音频未被截断', status: cs.length === chapterLimit && speechEvidence.every(item => item.current) ? 'PASS' : 'FAIL' });
  write('media-quality.json', { images: imageEvidence, bindings: bindingEvidence, identities: identityEvidence, scripts: scriptEvidence, coverage: coverageEvidence, continuity: { current: continuityCurrent, issues: continuityIssues }, reviews: reviewEvidence, submissions: submissionEvidence, hasUntrackedSubmissions, legacyOrderReviewed, speech: speechEvidence, delivery: deliveryEvidence });
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
  write('report.html', `<!doctype html><html lang="zh"><meta charset="utf-8"><title>NovaStory ${scopeLabel}生成验收</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:24px;line-height:1.65;color:#172033;background:#f4f6fa}h1{font-size:28px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border:1px solid #ddd;text-align:left}pre{white-space:pre-wrap;background:white;padding:20px;border-left:4px solid #5965d8}.ok{color:#16803a}.bad{color:#b33939}</style><h1>项目 ${projectId} · ${scopeLabel}生成验收</h1><p>本次验收仅覆盖前${chapterLimit}章；后续章节的既有素材保留，不计入本次通过条件。</p><p>生成时间：${escape(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</p><p>当前状态：${error ? '尚未完成' : '所选阶段执行完成'}；当前步骤：${escape(state.currentStep)}</p>${error ? `<pre>${escape(error.message)}</pre>` : ''}${engineering ? `<h2>功能核查与工程验证</h2><table>${engineering.checks.map(c => `<tr><td>${escape(c.name)}</td><td>${escape(c.status)}</td><td>${escape(c.evidence)}</td></tr>`).join('')}</table><h2>已完成的修复</h2><ul>${engineering.changes.map(c => `<li>${escape(c)}</li>`).join('')}</ul>` : ''}${state.preflight?.blockers?.length ? `<h2>实生成阻塞</h2><pre>${escape(state.preflight.blockers.join('\n'))}</pre>` : ''}<h2>执行记录</h2><table><tr><th>步骤</th><th>状态</th><th>说明</th></tr>${Object.entries(state.steps).map(([name, step]) => `<tr><td>${escape(name)}</td><td>${escape(step.status)}</td><td>${escape(step.error || step.completedAt || '')}</td></tr>`).join('')}</table>${acceptance ? `<h2>验收矩阵</h2><table>${acceptance.acceptance.map(a => `<tr><td>${escape(a.id)}</td><td>${escape(a.criterion)}</td><td class="${a.status === 'PASS' ? 'ok' : 'bad'}">${escape(a.status)}</td></tr>`).join('')}</table>` : '<p>产物尚未齐备，未判定内容、视觉或视频质量通过。</p>'}${manualReview ? `<h2>人工质量复核</h2><table>${manualReview.checks.map(item => `<tr><td>${escape(item.name)}</td><td>${escape(item.status)}</td><td>${escape(item.evidence)}</td></tr>`).join('')}</table><p>复核证据：${(manualReview.evidenceFiles || []).map(file => `<a href="./${escape(path.basename(file))}">${escape(path.basename(file))}</a>`).join(' · ')}</p>` : ''}<h2>实际生成与人工质量核验</h2><p>只有本项目真实产物齐备才可通过内容验收。跨镜头角色一致性、道具形状、对白及声音同步必须观看实生成结果后判定。角色、场景、道具和镜头视频默认由本机 ComfyUI 按项目设置生成。Codex 或 Grok 只有在命令明确要求时才使用。跨镜头外观仍需逐张目视核验，接口或单元测试不能代替画面验收。</p><p>续跑：<code>npm run production:full -- --project ${projectId} --base-url ${escape(base)} --chapter-limit ${chapterLimit} --asset-scope ${assetScope} --video-workflow ${escape(workflow)} --retry-failed${acceptLegacyStoryboards ? ' --accept-legacy-storyboards' : ''}</code></p><p>同目录 JSON、文本和视频保留分阶段证据。人工验收需检查人物一致性、叙事质量及音画同步。</p></html>`);
}
let failure;
try {
  const handlers = { preflight, text, scripts, assets, storyboards, images, audio, 'review-continuity': recordContinuityReview, 'review-task-order': recordLegacyTaskOrderReview, 'review-images': () => recordReview('images'), 'review-chapter': () => recordReview('chapters'), 'video-preflight': videoPreflight, videos, assemble, verify };
  if (stage === 'all') {
    await preflight();
    await text();
    for (const chapter of await chapters()) {
      await assertPriorChaptersReady(chapter);
      await scripts([chapter]);
      await storyboards([chapter]);
      await runChapterProductionStage(assets, [chapter]);
      await runChapterProductionStage(images, [chapter]);
      await requireImageReview(chapter);
      await videoPreflight([chapter]);
      await runChapterProductionStage(videos, [chapter]);
      await assemble([chapter], { fullFilm: false });
      await requireChapterReview(chapter);
    }
    await assemble(null, { shots: false, fullFilm: true });
    await verify();
  } else if (stage === 'preflight') await preflight();
  else {
    const selected = selectedChapterId ? (await chapters()).filter(chapter => String(chapter.id) === selectedChapterId) : null;
    if (selected && !selected.length) throw new Error('Selected chapter is outside this production scope');
    if (!['review-continuity', 'review-task-order', 'verify', 'assets', 'images', 'videos'].includes(stage)) await requireContinuityReview();
    if (['assets', 'images', 'videos'].includes(stage)) await runChapterProductionStage(handlers[stage], selected);
    else if (stage === 'assemble' && selected) await assemble(selected, { fullFilm: false });
    else await handlers[stage](selected);
  }
} catch (error) { failure = error; console.error(error.message); process.exitCode = 1; }
finally { report(failure); }
