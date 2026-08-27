/**
 * Pure AC checks for「失声的梦核游乐园」ch2/3/8/10 recompile contract.
 * Usable from fixture JSON (clean clone) or a live DB via CLI.
 */

export type DreamcoreAcScene = {
  index?: number | null;
  shot_type?: string | null;
  shot_intent?: string | null;
  visual_prompt?: string | null;
  negative_prompt?: string | null;
  shot_spec?: string | null;
};

export type DreamcoreAcChapter = {
  chapter_index: number;
  scenes: DreamcoreAcScene[];
};

export type DreamcoreAcFailure = {
  chapter_index: number;
  rule: string;
  detail: string;
};

const textOf = (scene: DreamcoreAcScene): string =>
  [
    scene.visual_prompt,
    scene.negative_prompt,
    scene.shot_spec,
    scene.shot_type,
    scene.shot_intent,
  ]
    .map((v) => String(v || ''))
    .join('\n');

const parseSpec = (raw: unknown): any => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
};

const isInsertLike = (scene: DreamcoreAcScene): boolean => {
  const intent = String(scene.shot_intent || parseSpec(scene.shot_spec)?.shot_intent || '').toLowerCase();
  if (intent === 'insert' || intent === 'payoff') return true;
  return /\binsert\b/i.test(String(scene.shot_type || ''));
};

export const assertDreamcoreAc = (
  chapters: DreamcoreAcChapter[]
): { ok: true } | { ok: false; failures: DreamcoreAcFailure[] } => {
  const byIndex = new Map(chapters.map((c) => [c.chapter_index, c]));
  const failures: DreamcoreAcFailure[] = [];

  const ch2 = byIndex.get(2);
  if (!ch2?.scenes?.length) {
    failures.push({
      chapter_index: 2,
      rule: 'present',
      detail: 'chapter 2 scenes missing',
    });
  } else {
    const hit = ch2.scenes.some((scene) => {
      const blob = textOf(scene).toLowerCase();
      return (
        isInsertLike(scene)
        && /(music-note|music note|button)/i.test(blob)
        && /(map|导览)/i.test(blob)
      );
    });
    if (!hit) {
      failures.push({
        chapter_index: 2,
        rule: 'map_button_insert',
        detail: 'expected an Insert with map + music-note button',
      });
    }
  }

  const ch3 = byIndex.get(3);
  if (!ch3?.scenes?.length) {
    failures.push({
      chapter_index: 3,
      rule: 'present',
      detail: 'chapter 3 scenes missing',
    });
  } else {
    const cloudLike = ch3.scenes.find((scene) =>
      /\bcloud-like\b/i.test(String(scene.visual_prompt || ''))
    );
    if (cloudLike) {
      failures.push({
        chapter_index: 3,
        rule: 'no_cloud_like',
        detail: `scene #${cloudLike.index ?? '?'} still contains bare cloud-like`,
      });
    }
  }

  const ch8 = byIndex.get(8);
  if (!ch8?.scenes?.length) {
    failures.push({
      chapter_index: 8,
      rule: 'present',
      detail: 'chapter 8 scenes missing',
    });
  } else {
    const hit = ch8.scenes.some((scene) => {
      const vp = String(scene.visual_prompt || '');
      const neg = String(scene.negative_prompt || '');
      return (
        isInsertLike(scene)
        && /music box/i.test(vp)
        && /aerial|satellite/i.test(neg)
      );
    });
    if (!hit) {
      failures.push({
        chapter_index: 8,
        rule: 'music_box_insert_negatives',
        detail: 'expected music-box Insert with aerial/satellite negatives',
      });
    }
  }

  const ch10 = byIndex.get(10);
  if (!ch10?.scenes?.length) {
    failures.push({
      chapter_index: 10,
      rule: 'present',
      detail: 'chapter 10 scenes missing',
    });
  } else {
    const hit = ch10.scenes.some((scene) => {
      const vp = String(scene.visual_prompt || '');
      const neg = String(scene.negative_prompt || '');
      const intent = String(
        scene.shot_intent || parseSpec(scene.shot_spec)?.shot_intent || ''
      ).toLowerCase();
      return (
        (intent === 'payoff' || isInsertLike(scene))
        && /core/i.test(vp)
        && /groove|slot|socket/i.test(vp)
        && /mecha|helmet/i.test(neg)
      );
    });
    if (!hit) {
      failures.push({
        chapter_index: 10,
        rule: 'payoff_core_groove',
        detail: 'expected payoff/insert with core+groove and mecha/helmet negatives',
      });
    }
  }

  if (failures.length) return { ok: false, failures };
  return { ok: true };
};
