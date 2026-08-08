import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAppearanceBase,
  buildTurnaroundViewPrompt,
  stitchTurnaroundSheet,
  shouldUseTurnaroundComposite,
  TURNAROUND_VIEWS
} from './turnaround_composite';
import sharp from 'sharp';

test('extractAppearanceBase strips multi-view sheet jargon', () => {
  const raw =
    'score_9, character turnaround sheet, multi-view layout, front view, side view, back view, 1girl, long black hair, moon-white dress';
  const cleaned = extractAppearanceBase(raw);
  assert.doesNotMatch(cleaned, /turnaround sheet/i);
  assert.doesNotMatch(cleaned, /multi-view/i);
  assert.match(cleaned, /long black hair/);
  assert.match(cleaned, /moon-white dress/);
});

test('buildTurnaroundViewPrompt is single-figure full body per angle', () => {
  const base = '1girl, long black hair, ice-blue eyes, moon-white xianxia dress';
  for (const view of TURNAROUND_VIEWS) {
    const { prompt, negative_prompt } = buildTurnaroundViewPrompt(base, view, 'pony');
    assert.match(prompt, /full body/i);
    assert.match(prompt, /1girl/);
    assert.match(prompt, /solid white background/);
    assert.doesNotMatch(prompt, /multi-view layout/i);
    assert.match(negative_prompt, /multiple girls|2girls/i);
    if (view.id === 'front') assert.match(prompt, /front view/i);
    if (view.id === 'side') assert.match(prompt, /side view|profile/i);
    if (view.id === 'back') assert.match(prompt, /back view|from behind/i);
  }
});

test('shouldUseTurnaroundComposite respects escape hatch', () => {
  assert.equal(shouldUseTurnaroundComposite({ gen_type: 'turnaround' }), true);
  assert.equal(shouldUseTurnaroundComposite({ gen_type: 'portrait' }), false);
  assert.equal(
    shouldUseTurnaroundComposite({ gen_type: 'turnaround', turnaround_mode: 'single' }),
    false
  );
  assert.equal(
    shouldUseTurnaroundComposite({ gen_type: 'turnaround', turnaround_composite: false }),
    false
  );
});

test('stitchTurnaroundSheet produces labeled wide sheet', async () => {
  const mk = async (r: number, g: number, b: number) =>
    sharp({
      create: { width: 200, height: 400, channels: 3, background: { r, g, b } }
    })
      .png()
      .toBuffer();

  const sheet = await stitchTurnaroundSheet([
    { buffer: await mk(200, 50, 50), label: 'FRONT' },
    { buffer: await mk(50, 200, 50), label: 'SIDE' },
    { buffer: await mk(50, 50, 200), label: 'BACK' }
  ]);

  const meta = await sharp(sheet).metadata();
  assert.ok(meta.width && meta.width > 1400);
  assert.ok(meta.height && meta.height > 900);
  assert.equal(meta.format, 'png');
});
