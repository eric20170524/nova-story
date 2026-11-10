import { createHash } from 'node:crypto';

export function fingerprint(value) {
  const normalize = item => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, normalize(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
export function shotContract(shot) {
  let spec = shot.shot_spec;
  if (typeof spec === 'string') { try { spec = JSON.parse(spec); } catch { spec = null; } }
  if (spec && typeof spec === 'object') {
    spec = { ...spec };
    delete spec.formal_request;
    delete spec.english_visual_prompt;
    delete spec.visual_prompt;
  }
  return { id: shot.id, chapter_id: shot.chapter_id, duration: shot.duration,
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
export function resolveSpeechLeadIn(blocks, durations, minimum = 5) {
  if (!Array.isArray(blocks) || !blocks.length) return 0;
  const validDurations = blocks.map((block, index) => {
    const duration = Number(durations?.[index]);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid speech duration for ${block?.id}`);
    return duration;
  });
  const totalSpeechSpan = validDurations.reduce((sum, d) => sum + d, 0) + validDurations.length * 0.15;
  const slack = Number(minimum || 5) - totalSpeechSpan;
  if (slack <= 0.4) return 0;
  const firstType = blocks[0]?.type;
  const proposed = firstType === 'voiceover'
    ? (slack >= 0.5 ? 0.25 : 0)
    : Math.min(0.5, Math.max(0.25, Math.round(slack * 0.18 * 24) / 24));
  return Number(Math.min(proposed, Math.max(0, slack)).toFixed(4));
}
export function timedSpeech(blocks, durations, minimum = 5) {
  let cursor = resolveSpeechLeadIn(blocks, durations, minimum);
  const cues = blocks.map((block, index) => {
    const duration = Number(durations[index]);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid speech duration for ${block.id}`);
    const start = Number(cursor.toFixed(4));
    const end = Number((cursor + duration).toFixed(4));
    const cue = { block_id: block.id, text: block.text.trim(), start, end };
    cursor += duration + 0.15; return cue;
  });
  return { cues, duration: Math.ceil(Math.max(minimum, cursor) * 24) / 24 };
}
export function nativeAudioFilter(hasSpeech, hasAudioPrompt = false) {
  if (!hasSpeech) {
    return '[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=1[native]';
  }
  const volume = hasAudioPrompt ? '0.12' : '0.06';
  return `[0:a]aresample=48000,aformat=channel_layouts=stereo,bandreject=f=1200:width_type=h:w=1800,volume=${volume}[native]`;
}

/**
 * Assemble audio for one shot.
 * H3 Ref2VA narrative_final already carries native speech — use that track alone.
 * Silent sources (legacy / FL2VA) still remux timed TTS files.
 */
export function buildAssembledShotAudioPlan({
  hasNativeAudio,
  speechFileCount = 0,
  cueStartsMs = [],
  durationSec,
}) {
  const duration = Number(durationSec);
  if (!(Number.isFinite(duration) && duration > 0)) {
    throw new Error('Assembled shot audio requires a positive duration');
  }
  if (hasNativeAudio) {
    return {
      useSpeechInputs: false,
      filterComplex: `[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=1,apad,atrim=duration=${duration}[audio]`,
    };
  }
  const filters = [];
  const tracks = [];
  for (let index = 0; index < speechFileCount; index += 1) {
    const delay = Math.max(0, Math.round(Number(cueStartsMs[index]) || 0));
    filters.push(`[${index + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[speech${index}]`);
    tracks.push(`[speech${index}]`);
  }
  if (!tracks.length) {
    return {
      useSpeechInputs: false,
      filterComplex: `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[audio]`,
    };
  }
  filters.push(`${tracks.join('')}amix=inputs=${tracks.length}:duration=longest:dropout_transition=0,volume=${tracks.length},alimiter=limit=0.95,apad,atrim=duration=${duration}[audio]`);
  return { useSpeechInputs: true, filterComplex: filters.join(';') };
}
export function resolveAssembledShotTiming(layoutDuration, probeInfo) {
  const rawClip = Number(probeInfo?.format?.duration);
  const clipSeconds = Number.isFinite(rawClip) && rawClip > 0 ? rawClip : 5;
  const speechDuration = Number.isFinite(Number(layoutDuration)) && Number(layoutDuration) > 0 ? Number(layoutDuration) : 5;
  const duration = Math.max(speechDuration, clipSeconds);
  const stopDuration = Math.max(0, Number((duration - clipSeconds).toFixed(6)));
  return {
    clipSeconds,
    duration,
    stopDuration,
    frames: Math.round(duration * 24),
  };
}
function timestamp(seconds) {
  const millis = Math.round(seconds * 1000);
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')},${String(millis % 1000).padStart(3, '0')}`;
}
function vttTimestamp(seconds) {
  const millis = Math.round(seconds * 1000);
  return `${String(Math.floor(millis / 3600000)).padStart(2, '0')}:${String(Math.floor(millis / 60000) % 60).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`;
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
export function webvtt(cues) {
  let number = 0;
  const blocks = (cues || []).flatMap(cue => {
    const characters = [...String(cue.text || '').replace(/\r?\n/g, ' ')];
    if (!characters.length) return [];
    const pages = [];
    for (let offset = 0; offset < characters.length; offset += 36) {
      const end = Math.min(offset + 36, characters.length);
      const text = characters.slice(offset, end);
      const lines = text.length > 18 ? `${text.slice(0, 18).join('')}\n${text.slice(18).join('')}` : text.join('');
      const startTime = cue.start + (cue.end - cue.start) * offset / characters.length;
      const endTime = cue.start + (cue.end - cue.start) * end / characters.length;
      pages.push(`${++number}\n${vttTimestamp(startTime)} --> ${vttTimestamp(endTime)}\n${lines}`);
    }
    return pages;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}
export function assertReview(record, snapshot, label) {
  if (!record || record.status !== 'approved' || !record.reviewer?.trim() || !record.reviewed_at || record.fingerprint !== fingerprint(snapshot)) throw new Error(`${label}: human approval is missing or its sources changed; review the current preview and record approval`);
}
