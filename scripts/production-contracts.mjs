import { createHash } from 'node:crypto';

export function fingerprint(value) {
  const normalize = item => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, normalize(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
export function shotContract(shot) {
  let spec = shot.shot_spec;
  if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch { spec = null; } }
  return { id: shot.id, chapter_id: shot.chapter_id, version: shot.active_version || 1, duration: shot.duration,
    spec, visual_prompt: shot.visual_prompt, motion_prompt: shot.motion_prompt, dialogue: shot.dialogue || '', narration: shot.narration || '', audio_prompt: shot.audio_prompt || '' };
}
export function validateScriptCoverage(script, shots) {
  const errors = [];
  if (!script || script.status !== 'confirmed' || script.freshness?.sourceChanged || !script.document?.scenes?.length || !shots.length) return ['Missing current confirmed script or storyboard'];
  const scenes = script.document.scenes;
  const seenScenes = new Set(), seenBlocks = new Set(), audible = [];
  let lastScene = -1;
  for (const shot of shots) {
    const source = shotContract(shot).spec?.source;
    const index = scenes.findIndex(scene => scene.id === source?.script_scene_id);
    if (source?.type !== 'script' || source.script_id !== script.id || source.script_revision !== script.revision || index < 0) { errors.push(`Shot ${shot.id}: stale script source`); continue; }
    if (index < lastScene) errors.push(`Shot ${shot.id}: scene order changed`);
    lastScene = index; seenScenes.add(index);
    const blocks = scenes[index].blocks || [];
    const ids = source.block_ids || [];
    let lastBlock = -1;
    const selected = [];
    for (const id of ids) {
      const position = blocks.findIndex(block => block.id === id);
      const token = `${index}:${id}`;
      if (position < 0 || seenBlocks.has(token) || position <= lastBlock) errors.push(`Shot ${shot.id}: missing, duplicate or reordered block ${id}`);
      if (position >= 0) { selected.push(blocks[position]); if (['dialogue', 'voiceover'].includes(blocks[position].type)) audible.push(token); }
      seenBlocks.add(token); lastBlock = position;
    }
    const text = type => selected.filter(block => block.type === type).map(block => block.text.trim());
    if ((shot.dialogue || '').trim() !== text('dialogue').join('\n') || (shot.narration || '').trim() !== text('voiceover').join('\n') || (shot.audio_prompt || '').trim() !== text('sound').join('; ')) errors.push(`Shot ${shot.id}: spoken or sound text differs from script`);
  }
  const expected = scenes.flatMap((scene, index) => (scene.blocks || []).filter(block => ['dialogue', 'voiceover'].includes(block.type)).map(block => `${index}:${block.id}`));
  if (seenScenes.size !== scenes.length) errors.push('Storyboard does not cover every script scene');
  if (JSON.stringify(audible) !== JSON.stringify(expected)) errors.push('Every spoken block must occur exactly once in script order');
  const missingSounds = scenes.flatMap((scene, index) => (scene.blocks || []).filter(block => block.type === 'sound' && !seenBlocks.has(`${index}:${block.id}`)).map(block => block.id));
  if (missingSounds.length) errors.push(`Storyboard omits sound blocks: ${missingSounds.join(', ')}`);
  return errors;
}
export function spokenBlocks(script, shot) {
  const source = shotContract(shot).spec?.source;
  const scene = script.document.scenes.find(scene => scene.id === source?.script_scene_id);
  return (source?.block_ids || []).map(id => scene?.blocks.find(block => block.id === id)).filter(block => block && ['dialogue', 'voiceover'].includes(block.type));
}
export function timedSpeech(blocks, durations, minimum = 5) {
  let cursor = 0;
  const cues = blocks.map((block, index) => {
    const duration = Number(durations[index]);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid speech duration for ${block.id}`);
    const cue = { block_id: block.id, text: block.text.trim(), start: cursor, end: cursor + duration };
    cursor += duration + 0.15; return cue;
  });
  return { cues, duration: Math.ceil(Math.max(minimum, cursor) * 24) / 24 };
}
function timestamp(seconds) {
  const millis = Math.round(seconds * 1000);
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')},${String(millis % 1000).padStart(3, '0')}`;
}
export function subtitles(cues) {
  let number = 0;
  return cues.flatMap(cue => {
    const characters = [...cue.text.replace(/\r?\n/g, ' ')];
    const pages = [];
    for (let offset = 0; offset < characters.length; offset += 36) {
      const end = Math.min(offset + 36, characters.length);
      const text = characters.slice(offset, end);
      const lines = text.length > 18 ? `${text.slice(0, 18).join('')}\n${text.slice(18).join('')}` : text.join('');
      const startTime = cue.start + (cue.end - cue.start) * offset / characters.length;
      const endTime = cue.start + (cue.end - cue.start) * end / characters.length;
      pages.push(`${++number}\n${timestamp(startTime)} --> ${timestamp(endTime)}\n${lines}\n`);
    }
    return pages;
  }).join('\n');
}
export function assertReview(record, snapshot, label) {
  if (!record || record.status !== 'approved' || !record.reviewer?.trim() || !record.reviewed_at || record.fingerprint !== fingerprint(snapshot)) throw new Error(`${label}: human approval is missing or its sources changed; review the current preview and record approval`);
}
