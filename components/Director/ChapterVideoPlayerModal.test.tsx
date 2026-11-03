import React, { act } from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ChapterVideoPlayerModal } from './ChapterVideoPlayerModal';
import type { ChapterVideoStatus } from '../../types';

const mockStatus: ChapterVideoStatus = {
  project_id: 90713821,
  chapter_id: '763fe2b7-2db7-4d55-88ff-97d4c1e0a7e6',
  chapter_index: 1,
  chapter_title: '初章·春潮将至',
  assembled: {
    available: true,
    url: '/static/generated/projects/90713821/chapters/chapter-1.mp4',
    subtitle_url: '/static/generated/projects/90713821/chapters/chapter-1.srt',
    vtt_url: '/static/generated/projects/90713821/chapters/chapter-1.vtt',
    duration: 180.75,
    sha256: 'd964d764e52fc3f392ac74d0ae80e665d904e868fbdfc4e0ae12b1be98b2bc3a',
    subtitle_sha256: '35f72b754882f1ef220ef75efae9ec37208956d5b41206d93825c69330b534d8',
    created_at: '2026-11-02T13:58:10.967Z',
    cues: [
      { block_id: 'b_1_6', text: '嘉静，你还好吗？', start: 0, end: 1.92 },
      { block_id: 'b_1_8', text: '春潮来了，气息不稳。', start: 2.07, end: 8.39 },
    ],
    shot_durations: [
      { scene_id: 302, duration: 10.75 },
      { scene_id: 303, duration: 8 },
    ],
  },
  preview: {
    available: true,
    url: '/static/generated/projects/90713821/chapters/chapter-1-preview-subtitled.mp4',
    label: '阶段带字幕预览片',
  },
  review: {
    status: 'approved',
    reviewer: 'auto_operator',
    reviewed_at: '2026-11-02T14:00:29.946Z',
  },
  shots_summary: {
    total_shots: 21,
    ready_video_shots: 21,
    any_video_shots: 21,
    all_ready: true,
  },
  shot_playlist: [
    {
      scene_id: 302,
      shot_number: 1,
      duration: 10.75,
      start_time: 0,
      end_time: 10.75,
      video_url: '/static/generated/videos/90713821/302/final.mp4',
      video_role: 'narrative_final',
      video_status: 'ready',
      poster_url: '/static/frame-302.png',
      dialogue: '嘉静，你还好吗？',
      narration: '',
      visual_prompt: '清暮宫玉阶',
    },
    {
      scene_id: 303,
      shot_number: 2,
      duration: 8,
      start_time: 10.75,
      end_time: 18.75,
      video_url: '/static/generated/videos/90713821/303/final.mp4',
      video_role: 'narrative_final',
      video_status: 'ready',
      poster_url: '/static/frame-303.png',
      dialogue: '',
      narration: '',
      visual_prompt: '花海灵雾',
    },
  ],
};

test('ChapterVideoPlayerModal renders assembled chapter video, Chinese subtitles, and shot timeline', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  if (dom.window.HTMLDialogElement) {
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }
  if (dom.window.HTMLMediaElement) {
    dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    dom.window.HTMLMediaElement.prototype.pause = () => {};
  }

  const original = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const events: string[] = [];

  await act(async () => {
    root.render(
      <ChapterVideoPlayerModal
        isOpen={true}
        onClose={() => events.push('close')}
        chapterTitle="初章·春潮将至"
        chapterIndex={1}
        videoStatus={mockStatus}
        isLoading={false}
        isAssembling={false}
        onAssemble={() => events.push('assemble')}
        onRefresh={() => events.push('refresh')}
        onJumpToScene={(sceneId) => events.push(`jump:${sceneId}`)}
      />
    );
  });

  try {
    const doc = dom.window.document;
    const dialog = doc.querySelector('[data-testid="chapter-video-player-modal"]') as HTMLDialogElement;
    assert.ok(dialog);
    assert.equal(dialog.hasAttribute('open'), true);
    assert.equal(dialog.getAttribute('closedby'), 'any');

    const video = doc.querySelector('[data-testid="chapter-full-video-element"]') as HTMLVideoElement;
    assert.ok(video);
    assert.equal(video.getAttribute('src'), '/static/generated/projects/90713821/chapters/chapter-1.mp4');
    assert.equal(video.getAttribute('width'), '1280');
    assert.equal(video.getAttribute('height'), '720');

    const track = video.querySelector('track');
    assert.ok(track);
    assert.equal(track?.getAttribute('src'), '/static/generated/projects/90713821/chapters/chapter-1.vtt');

    const subtitle = doc.querySelector('[data-testid="chapter-live-subtitle"]');
    assert.ok(subtitle);
    assert.match(subtitle?.textContent || '', /嘉静，你还好吗？/);
    assert.match(doc.body.textContent || '', /整章成片已合流 \(03:00\)/);
    assert.match(doc.body.textContent || '', /已通过章节验收/);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

