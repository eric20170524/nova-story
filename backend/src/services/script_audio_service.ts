import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db, withImmediateTransaction } from '../db/database';
import { SettingsManager } from '../core/settings_manager';
import { hashCanonical } from '../schemas/story_plan';
import { ScriptService } from './script_service';
import { TtsService, TtsServiceError } from './tts_service';
import { MediaAssetService } from './video/media_asset_service';
const execFileAsync = promisify(execFile);

export interface ScriptAudioRequest { script_id: number; expected_revision: number; block_id: string; request_key: string; voice_id?: string }

export class ScriptAudioService {
  private static pending = new Map<string, Promise<unknown>>();

  static async markInterruptedRequests(): Promise<void> {
    await db.run("UPDATE media_asset SET status = 'rejected', metadata_json = json_set(metadata_json, '$.interrupted', 1) WHERE role = 'script_speech' AND status = 'draft'");
  }

  static async render(input: ScriptAudioRequest): Promise<any> {
    const script = await ScriptService.getScriptById(input.script_id);
    if (script.status !== 'confirmed' || script.freshness.sourceChanged || script.revision !== input.expected_revision) throw new TtsServiceError('SCRIPT_SOURCE_CHANGED', 'Confirm the current script before producing speech', 409);
    const blocks = script.document.scenes.flatMap(scene => scene.blocks);
    const block = blocks.find(block => block.id === input.block_id);
    if (!block || !['dialogue', 'voiceover'].includes(block.type)) throw new TtsServiceError('INVALID_SPEECH_BLOCK', 'block_id must identify a dialogue or voiceover block', 400);
    const speakerId = 'characterId' in block ? block.characterId : null;
    const character = speakerId != null ? await db.get('SELECT voice_id, active_version FROM character WHERE id = ? AND project_id = ?', speakerId, script.projectId) : null;
    if (speakerId != null && !character) throw new TtsServiceError('INVALID_SPEECH_CHARACTER', 'Speaker is not in the current project', 409);
    const voiceId = input.voice_id || character?.voice_id || (await TtsService.getStatus()).default_voice;
    if (!voiceId) throw new TtsServiceError('VOICE_NOT_FOUND', 'Select an available voice before producing speech', 400);
    const source = { script_id: script.id, script_revision: script.revision, block_id: block.id, text: block.text.trim(), character_id: speakerId, character_version: character?.active_version || null, voice_id: voiceId, tts: SettingsManager.loadSettings().tts };
    const signature = hashCanonical(source);
    const pendingKey = `${input.request_key}:${signature}`;
    const existing = this.pending.get(pendingKey);
    if (existing) return existing;
    const operation = this.renderReserved(input, source, signature, script.projectId);
    this.pending.set(pendingKey, operation);
    try { return await operation; } finally { this.pending.delete(pendingKey); }
  }

  private static async renderReserved(input: ScriptAudioRequest, source: any, signature: string, projectId: number) {
    const reservation = await withImmediateTransaction(async () => {
      const previous = await db.get("SELECT * FROM media_asset WHERE role = 'script_speech' AND json_extract(metadata_json, '$.request_key') = ? ORDER BY id DESC LIMIT 1", input.request_key);
      if (previous) {
        const metadata = JSON.parse(previous.metadata_json);
        if (metadata.input_hash !== signature) throw new TtsServiceError('AUDIO_KEY_CONFLICT', 'Speech request key was used with different source or voice', 409);
        if (previous.status === 'ready') {
          const file = MediaAssetService.resolveSafePath(previous.url);
          if (!fs.existsSync(file) || MediaAssetService.computeSha256(file) !== previous.sha256) throw new TtsServiceError('AUDIO_FILE_CHANGED', 'Speech file is missing or changed; retry with a new request key', 409);
          return { asset: previous, reuse: true };
        }
        throw new TtsServiceError(previous.status === 'draft' ? 'AUDIO_PROCESSING' : metadata.interrupted ? 'AUDIO_INTERRUPTED' : 'AUDIO_FAILED', 'Speech request is pending or failed; inspect it before retrying with a new request key', 409);
      }
      const relative = `generated/audio/${projectId}/${input.script_id}/${input.expected_revision}/${signature}-${hashCanonical(input.request_key).slice(0, 12)}.mp3`;
      const asset = await MediaAssetService.createAsset({ project_id: projectId, character_id: source.character_id, media_type: 'audio', role: 'script_speech', status: 'draft', url: `/static/${relative}`, mime_type: 'audio/mpeg', metadata_json: JSON.stringify({ source, input_hash: signature, request_key: input.request_key }) });
      return { asset, reuse: false };
    });
    if (reservation.reuse) return { asset: reservation.asset, source };
    const asset = reservation.asset;
    const file = MediaAssetService.resolveSafePath(asset.url);
    try {
      const audio = await TtsService.synthesize({ voice_id: source.voice_id, text: source.text });
      const latest = await ScriptService.getScriptById(input.script_id);
      if (latest.revision !== input.expected_revision || latest.status !== 'confirmed' || latest.freshness.sourceChanged) throw new TtsServiceError('SCRIPT_SOURCE_CHANGED', 'Script changed while speech was being produced', 409);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const raw = `${file}.source`, normalized = `${file}.tmp.mp3`;
      fs.writeFileSync(raw, audio.buffer);
      try {
        await execFileAsync('ffmpeg', ['-v', 'error', '-xerror', '-y', '-i', raw, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-ar', '48000', '-ac', '1', normalized], { timeout: 120000 });
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', normalized]);
        const probe = JSON.parse(stdout);
        const duration = Number(probe.format?.duration);
        if (!probe.streams?.some((stream: any) => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0) throw new Error('No decodable audio');
        const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-i', normalized, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 120000 });
        const peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(stderr)?.[1]);
        if (!Number.isFinite(peak) || peak < -60) throw new TtsServiceError('AUDIO_SILENT', '正式配音无可听声音，请检查 TTS 输出后重试', 503);
        const latestBeforeSave = await ScriptService.getScriptById(input.script_id);
        if (latestBeforeSave.revision !== input.expected_revision || latestBeforeSave.status !== 'confirmed' || latestBeforeSave.freshness.sourceChanged) throw new TtsServiceError('SCRIPT_SOURCE_CHANGED', 'Script changed while speech was being processed', 409);
        if (source.character_id != null) {
          const latestCharacter = await db.get('SELECT active_version FROM character WHERE id = ? AND project_id = ?', source.character_id, projectId);
          if (!latestCharacter || latestCharacter.active_version !== source.character_version) throw new TtsServiceError('AUDIO_SOURCE_CHANGED', 'Speaker changed while speech was being produced', 409);
        }
        fs.renameSync(normalized, file);
        await db.run('UPDATE media_asset SET duration_ms = ? WHERE id = ?', Math.round(duration * 1000), asset.id);
      } finally {
        for (const temporary of [raw, normalized]) { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      const sha256 = MediaAssetService.computeSha256(file);
      await db.run("UPDATE media_asset SET status = 'ready', sha256 = ? WHERE id = ?", sha256, asset.id);
      return { asset: await MediaAssetService.getAssetById(asset.id!), source };
    } catch (error) {
      await db.run("UPDATE media_asset SET status = 'rejected' WHERE id = ?", asset.id);
      if (error instanceof TtsServiceError) throw error;
      throw new TtsServiceError('AUDIO_INVALID', '正式配音未能解码，请检查 TTS 音频及 FFmpeg 环境', 503);
    }
  }
}
