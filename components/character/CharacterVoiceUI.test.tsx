import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../../LanguageContext';
import { ToastProvider } from '../../ToastContext';
import { CharacterCard } from './CharacterCard';
import { CharacterEditModal } from './CharacterEditModal';
import { TtsStatusCard } from '../settings/TtsStatusCard';
import { Character } from '../../types';

const baseCharacter: Character = {
  id: 1,
  project_id: 10,
  name: '林川',
  role: 'protagonist',
  description: '剑修弟子，身负残卷。',
  visual_tags: {},
  avatar_url: null as any,
  turnaround_url: null as any,
  voice_id: null,
  voice_label: null,
};

test('CharacterCard renders voice label when set', () => {
  const charWithVoice: Character = {
    ...baseCharacter,
    voice_id: 'QF1',
    voice_label: 'QF1 · Serena · 高质温柔',
  };

  const html = renderToStaticMarkup(
    <LanguageProvider>
      <CharacterCard
        char={charWithVoice}
        expandedDesc={false}
        expandedTags={false}
        onToggleDesc={() => {}}
        onToggleTags={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onOpenSheetModal={() => {}}
        onCropFace={() => {}}
        onTrainLora={() => {}}
        onUploadAsset={() => {}}
        onSwitchVersion={() => {}}
        onCreateVersion={() => {}}
        onOpenPreview={() => {}}
      />
    </LanguageProvider>
  );

  assert.match(html, /data-testid="character-card-voice"/);
  assert.match(html, /QF1 · Serena · 高质温柔/);
});

test('CharacterCard renders unassigned voice fallback when empty', () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <CharacterCard
        char={baseCharacter}
        expandedDesc={false}
        expandedTags={false}
        onToggleDesc={() => {}}
        onToggleTags={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onOpenSheetModal={() => {}}
        onCropFace={() => {}}
        onTrainLora={() => {}}
        onUploadAsset={() => {}}
        onSwitchVersion={() => {}}
        onCreateVersion={() => {}}
        onOpenPreview={() => {}}
      />
    </LanguageProvider>
  );

  assert.match(html, /data-testid="character-card-voice"/);
  assert.match(html, /未设定音色/);
});

test('CharacterEditModal renders voice controls and testids', () => {
  const html = renderToStaticMarkup(
    <ToastProvider>
      <LanguageProvider>
        <CharacterEditModal
          isOpen={true}
          editingChar={{
            ...baseCharacter,
            voice_id: null,
            voice_label: null,
          }}
          setEditingChar={() => {}}
          onClose={() => {}}
          onSave={() => {}}
          onUploadAsset={() => {}}
        />
      </LanguageProvider>
    </ToastProvider>
  );

  assert.match(html, /data-testid="character-voice-status"/);
  assert.match(html, /data-testid="character-voice-select"/);
  assert.match(html, /data-testid="character-voice-preview"/);
  assert.match(html, /data-testid="character-voice-clear"/);
  assert.match(html, /未设定音色（留空）/);
  // Preview and clear should be disabled when voice_id is null
  assert.match(html, /data-testid="character-voice-clear"[^>]*\bdisabled=""/);
});

test('CharacterEditModal indicates missing voice when saved voice is not in catalog', () => {
  const html = renderToStaticMarkup(
    <ToastProvider>
      <LanguageProvider>
        <CharacterEditModal
          isOpen={true}
          editingChar={{
            ...baseCharacter,
            voice_id: 'C_OLD_DELETED_VOICE',
            voice_label: 'C_OLD_DELETED_VOICE · 旧克隆 · 消失',
          }}
          setEditingChar={() => {}}
          onClose={() => {}}
          onSave={() => {}}
          onUploadAsset={() => {}}
        />
      </LanguageProvider>
    </ToastProvider>
  );

  assert.match(html, /data-testid="character-voice-select"/);
  assert.match(html, /C_OLD_DELETED_VOICE/);
  // Clear should be enabled when voice_id is set
  assert.doesNotMatch(html, /data-testid="character-voice-clear"[^>]*\bdisabled=""/);
});

test('TtsStatusCard renders connected state with voice count and default voice', () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <TtsStatusCard
        ttsStatus={{
          ok: true,
          enabled: true,
          base_url: 'http://127.0.0.1:8765',
          voice_count: 32,
          default_voice: 'QF1',
          local_models: { light: true, quality: true, clone: true },
        }}
        loadingTts={false}
      />
    </LanguageProvider>
  );

  assert.match(html, /data-testid="tts-status-card"/);
  assert.match(html, /data-testid="tts-status-badge"/);
  assert.match(html, /已连通/);
  assert.match(html, /data-testid="tts-base-url"/);
  assert.match(html, /http:\/\/127\.0\.0\.1:8765/);
  assert.match(html, /data-testid="tts-voice-count"/);
  assert.match(html, /32 个/);
  assert.match(html, /data-testid="tts-default-voice"/);
  assert.match(html, /QF1/);
  assert.match(html, /data-testid="tts-models-status"/);
  assert.match(html, /已就绪/);
  assert.match(html, /data-testid="tts-model-light"/);
  assert.match(html, /轻量: 已加载/);
  assert.match(html, /data-testid="tts-model-quality"/);
  assert.match(html, /高质: 已加载/);
  assert.match(html, /data-testid="tts-model-clone"/);
  assert.match(html, /克隆: 已加载/);
  assert.match(html, /data-testid="tts-refresh-btn"/);
  assert.match(html, /中文语音合成服务 \(TTS\)/);
});

test('TtsStatusCard renders disconnected state when upstream is down', () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <TtsStatusCard
        ttsStatus={{
          ok: false,
          enabled: false,
          base_url: 'http://127.0.0.1:8765',
          voice_count: 0,
        }}
        loadingTts={false}
      />
    </LanguageProvider>
  );

  assert.match(html, /data-testid="tts-status-card"/);
  assert.match(html, /data-testid="tts-status-badge"/);
  assert.match(html, /未连通/);
  assert.match(html, /data-testid="tts-voice-count"/);
  assert.match(html, /0 个/);
  assert.match(html, /未就绪/);
  assert.match(html, /轻量: 未加载/);
  assert.match(html, /高质: 未加载/);
  assert.match(html, /克隆: 未加载/);
});

test('TtsStatusCard is not ready when ok is true but every local model flag is false', () => {
  const renderCard = (ttsStatus: { local_models?: { light: boolean; quality: boolean; clone: boolean } }) =>
    renderToStaticMarkup(
      <LanguageProvider>
        <TtsStatusCard
          ttsStatus={{
            ok: true,
            enabled: true,
            base_url: 'http://127.0.0.1:8765',
            voice_count: 13,
            default_voice: 'QF1',
            ...ttsStatus,
          }}
        />
      </LanguageProvider>
    );

  for (const html of [
    renderCard({ local_models: { light: false, quality: false, clone: false } }),
    renderCard({}),
  ]) {
    assert.match(html, /data-testid="tts-models-status"/);
    assert.match(html, /已连通/);
    assert.match(html, /未就绪/);
    assert.match(html, /轻量: 未加载/);
    assert.match(html, /高质: 未加载/);
    assert.match(html, /克隆: 未加载/);
    assert.doesNotMatch(html, /已就绪/);
    assert.doesNotMatch(html, /已加载/);
  }
});

