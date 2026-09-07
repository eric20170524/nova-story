import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS = [
  'minimax_h3_hongchao_a2a_12gb',
  'minimax_h3_ref2va_official_12gb',
  'minimax_h3_fl2va_official_12gb'
] as const;

type WorkflowId = (typeof WORKFLOWS)[number];

type BenchmarkRow = {
  workflow_id: WorkflowId;
  seed: number;
  preflight_ready: boolean;
  status: string;
  stage?: string;
  elapsed_seconds: number;
  seam_cost?: number;
  normalized_score?: number;
  quality_grade?: string;
  output_url?: string | null;
  task_id?: string;
  error?: string;
  blockers?: string[];
};

type Args = {
  baseUrl: string;
  sceneId: number;
  sceneVersion: number;
  profile: 'narrative_clip' | 'character_loop';
  preset: 'preview_480p_5s' | 'standard_720p_5s';
  keyframeAssetId: number;
  lastFrameAssetId?: number;
  characterReferenceAssetIds: number[];
  motionReferenceAssetId?: number;
  workflows: WorkflowId[];
  seeds: number[];
  output: string;
  pollMs: number;
  timeoutMs: number;
};

const parseCsvNumbers = (raw?: string): number[] =>
  String(raw || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));

const parseArgs = (): Args => {
  const values = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      values.set(key, next);
      i += 1;
    } else {
      values.set(key, 'true');
    }
  }

  const sceneId = Number(values.get('scene-id'));
  const keyframeAssetId = Number(values.get('keyframe'));
  if (!Number.isFinite(sceneId) || !Number.isFinite(keyframeAssetId)) {
    throw new Error('Required: --scene-id <id> --keyframe <media_asset_id>');
  }

  const requestedWorkflows = String(values.get('workflows') || WORKFLOWS.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is WorkflowId => (WORKFLOWS as readonly string[]).includes(value));
  if (requestedWorkflows.length === 0) {
    throw new Error(`No valid workflows. Allowed: ${WORKFLOWS.join(', ')}`);
  }

  const seeds = parseCsvNumbers(values.get('seeds'));
  if (seeds.length === 0) seeds.push(11, 22, 33);

  const profileRaw = values.get('profile') || 'character_loop';
  const profile = profileRaw === 'narrative_clip' ? 'narrative_clip' : 'character_loop';
  const presetRaw = values.get('preset') || 'preview_480p_5s';
  const preset = presetRaw === 'standard_720p_5s' ? 'standard_720p_5s' : 'preview_480p_5s';

  return {
    baseUrl: String(values.get('base-url') || 'http://127.0.0.1:3000/api').replace(/\/$/, ''),
    sceneId,
    sceneVersion: Number(values.get('scene-version') || 1),
    profile,
    preset,
    keyframeAssetId,
    lastFrameAssetId: Number(values.get('last-frame')) || undefined,
    characterReferenceAssetIds: parseCsvNumbers(values.get('char-refs')),
    motionReferenceAssetId: Number(values.get('motion-ref')) || undefined,
    workflows: requestedWorkflows,
    seeds,
    output: path.resolve(values.get('output') || `video-benchmark-${Date.now()}.json`),
    pollMs: Math.max(500, Number(values.get('poll-ms') || 2000)),
    timeoutMs: Math.max(60_000, Number(values.get('timeout-ms') || 45 * 60 * 1000))
  };
};

const requestJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {})
    }
  });
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error || payload?.detail || `HTTP ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return payload as T;
};

const buildRequest = (args: Args, workflowId: WorkflowId, seed: number) => {
  const base: Record<string, unknown> = {
    scene_id: args.sceneId,
    scene_version: args.sceneVersion,
    profile: args.profile,
    workflow_id: workflowId,
    keyframe_asset_id: args.keyframeAssetId,
    preset: args.preset,
    seed,
    run_loop_closer: true
  };

  if (workflowId === 'minimax_h3_fl2va_official_12gb') {
    base.character_reference_asset_ids = [];
    if (args.lastFrameAssetId) base.last_frame_asset_id = args.lastFrameAssetId;
    return base;
  }

  base.character_reference_asset_ids = args.characterReferenceAssetIds;
  if (args.motionReferenceAssetId) base.motion_reference_asset_id = args.motionReferenceAssetId;
  // Official Ref2VA intentionally omits hard last-frame input. Experimental Hybrid
  // may include it so the benchmark can compare K->K/K0->K1 behavior explicitly.
  if (workflowId === 'minimax_h3_hongchao_a2a_12gb' && args.lastFrameAssetId) {
    base.last_frame_asset_id = args.lastFrameAssetId;
  }
  return base;
};

const terminalStatus = (task: any): boolean =>
  ['completed', 'review_required', 'rejected', 'failed', 'cancelled', 'interrupted'].includes(task?.status)
  || ['completed', 'review_required', 'rejected', 'failed', 'cancelled', 'interrupted'].includes(task?.stage);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForTask = async (args: Args, taskId: string) => {
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    const task = await requestJson<any>(`${args.baseUrl}/videos/tasks/${taskId}`);
    if (terminalStatus(task)) return task;
    await sleep(args.pollMs);
  }
  try {
    await requestJson(`${args.baseUrl}/videos/tasks/${taskId}/cancel`, { method: 'POST' });
  } catch {}
  throw new Error(`Benchmark task ${taskId} exceeded ${Math.round(args.timeoutMs / 1000)}s`);
};

const csvEscape = (value: unknown) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const writeResults = (args: Args, rows: BenchmarkRow[]) => {
  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    target: {
      base_url: args.baseUrl,
      scene_id: args.sceneId,
      scene_version: args.sceneVersion,
      profile: args.profile,
      preset: args.preset,
      workflows: args.workflows,
      seeds: args.seeds
    },
    rows
  };
  fs.writeFileSync(args.output, JSON.stringify(payload, null, 2), 'utf-8');

  const csvPath = args.output.replace(/\.json$/i, '') + '.csv';
  const headers: Array<keyof BenchmarkRow> = [
    'workflow_id', 'seed', 'preflight_ready', 'status', 'stage', 'elapsed_seconds',
    'seam_cost', 'normalized_score', 'quality_grade', 'task_id', 'output_url', 'error'
  ];
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))
  ];
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf-8');
  return { jsonPath: args.output, csvPath };
};

const main = async () => {
  const args = parseArgs();
  const rows: BenchmarkRow[] = [];

  console.log(`NovaStory H3 benchmark: ${args.workflows.length} workflow(s) × ${args.seeds.length} seed(s)`);
  console.log(`Scene ${args.sceneId}, preset=${args.preset}, profile=${args.profile}`);

  for (const workflowId of args.workflows) {
    for (const seed of args.seeds) {
      const body = buildRequest(args, workflowId, seed);
      const started = Date.now();
      const row: BenchmarkRow = {
        workflow_id: workflowId,
        seed,
        preflight_ready: false,
        status: 'not_started',
        elapsed_seconds: 0
      };

      try {
        const preflight = await requestJson<any>(`${args.baseUrl}/videos/preflight`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        row.preflight_ready = Boolean(preflight.ready);
        row.blockers = preflight.blockers || [];
        if (!preflight.ready) {
          row.status = 'preflight_blocked';
          row.error = (preflight.blockers || []).join('; ');
          row.elapsed_seconds = Math.round((Date.now() - started) / 100) / 10;
          rows.push(row);
          console.log(`[BLOCKED] ${workflowId} seed=${seed}: ${row.error}`);
          continue;
        }

        const submitted = await requestJson<{ task_id: string }>(`${args.baseUrl}/videos/generate`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        row.task_id = submitted.task_id;
        const task = await waitForTask(args, submitted.task_id);
        row.status = task.status || 'unknown';
        row.stage = task.stage;
        row.output_url = task.output_url;
        row.error = task.error || undefined;
        row.seam_cost = task.qa_report?.continuity_scores?.seam_cost;
        row.normalized_score = task.qa_report?.continuity_scores?.normalized_score;
        row.quality_grade = task.qa_report?.quality_grade;
      } catch (error: any) {
        row.status = 'error';
        row.error = error?.message || String(error);
      }

      row.elapsed_seconds = Math.round((Date.now() - started) / 100) / 10;
      rows.push(row);
      console.log(
        `[${row.status}] ${workflowId} seed=${seed} ${row.elapsed_seconds}s `
        + `seam=${row.seam_cost ?? '-'} score=${row.normalized_score ?? '-'}`
      );
    }
  }

  const files = writeResults(args, rows);
  console.log(`Results: ${files.jsonPath}`);
  console.log(`CSV: ${files.csvPath}`);

  const successful = rows.filter((row) => row.status === 'completed' || row.stage === 'review_required').length;
  if (successful === 0) process.exitCode = 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
