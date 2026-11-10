#!/usr/bin/env bash
# Remake project 90713824 chapter videos after enabling H3 Ref2VA native AV audio.
# Run on the production host that has ComfyUI, TTS, and the project DB.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PROJECT=90713824
FLAGS=(--project "$PROJECT" --chapter-limit 2 --auto-approve --keep-portraits --llm-mode remote --asset-scope all --video-workflow minimax_h3_ref2va_official_12gb --retry-failed)

echo "==> Ensure API is running with the AV workflow (restart npm run dev if needed)"
curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null

LOCK="$ROOT/local/production/$PROJECT/.production.lock"
rm -f "$LOCK"

echo "==> Archive ready silent narrative_final assets for current CH1/CH2 shots"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = (() => { try { return require('better-sqlite3'); } catch { return null; } })();
const base = 'http://127.0.0.1:3000/api';
const chapters = await fetch(`${base}/projects/90713824/chapters`).then(r => r.json()).catch(() => null);
async function request(url, method = 'GET', body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
const timeline = [];
for (const chapter of (await request('/projects/90713824/chapters')).chapters?.slice?.(0, 2) || []) {
  const tl = await request(`/timeline/${chapter.id}`);
  timeline.push(...(tl.timeline || []));
}
const shotIds = timeline.map(s => s.id);
console.log('shots', shotIds.join(','));
for (const id of shotIds) {
  const media = await request(`/scenes/${id}/media`);
  for (const asset of (media.assets || []).filter(a => a.role === 'narrative_final' && ['ready', 'draft', 'review_required'].includes(a.status))) {
    await request(`/videos/assets/${asset.id}/archive`, 'POST', {});
    console.log('archived', id, asset.id);
  }
}
const statePath = path.join('local/production/90713824/state.json');
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const key of Object.keys(state.steps || {})) {
    if (shotIds.some(id => key.startsWith(`shot-${id}:video:`))) delete state.steps[key];
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log('cleared video steps for', shotIds.length, 'shots');
}
NODE

echo "==> Regenerate videos then assemble"
npm run production:full -- "${FLAGS[@]}" --stage videos
npm run production:full -- "${FLAGS[@]}" --stage assemble

echo "==> Spot-check first assembled shot for audio"
FIRST=$(ls local/production/"$PROJECT"/videos/shot-*.mp4 2>/dev/null | head -1 || true)
if [[ -n "$FIRST" ]]; then
  ffprobe -v error -select_streams a -show_entries stream=codec_name,channels -of csv=p=0 "$FIRST"
fi
echo "Done."
