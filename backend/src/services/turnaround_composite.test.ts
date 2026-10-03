import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAppearanceBase,
  buildTurnaroundViewPrompt,
  buildTurnaroundPanelWorkflowData,
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

test('turnaround prompt keeps stable design and removes scene mood', () => {
  const cleaned = extractAppearanceBase(
    '1girl, long black hair, ice-blue eyes, melting expression, half-open inner robe, moon-white xianxia dress, enchanted mirror'
  );
  assert.match(cleaned, /long black hair/);
  assert.match(cleaned, /moon-white xianxia dress/);
  assert.doesNotMatch(cleaned, /melting|half-open/i);
  assert.doesNotMatch(cleaned, /mirror/i);
  const side = buildTurnaroundViewPrompt(cleaned, TURNAROUND_VIEWS[1]!, 'pony');
  assert.match(side.prompt, /neutral expression|A-pose/i);
  assert.match(side.prompt, /90 degree left side profile/i);
  assert.doesNotMatch(side.prompt, /character reference sheet|character design sheet panel/i);
});

test('panels default to text only; front adapter requires explicit opt-in', () => {
  const base = {
    model_type: 'pony',
    nsfw_enabled: true,
    project_settings: { default_workflow_id: 7 },
    character_adapter_weight: 0.75
  };
  for (const view of TURNAROUND_VIEWS) {
    const panel = buildTurnaroundPanelWorkflowData(base, view, 'prompt', 'negative', '/portrait.png');
    assert.equal(panel.character_ref_url, undefined);
    assert.equal(panel.force_no_character_adapter, true);
    assert.equal(panel.nsfw_enabled, false);
    assert.deepEqual(panel.project_settings, { default_workflow_id: 7 });
  }

  const front = buildTurnaroundPanelWorkflowData(
    { ...base, turnaround_front_adapter: true },
    TURNAROUND_VIEWS[0]!,
    'prompt',
    'negative',
    '/portrait.png'
  );
  assert.equal(front.character_ref_url, '/portrait.png');
  assert.equal(front.character_adapter_weight, 0.35);
  assert.equal(front.force_no_character_adapter, false);
  const back = buildTurnaroundPanelWorkflowData(
    base,
    TURNAROUND_VIEWS[2]!,
    'prompt',
    'negative',
    '/portrait.png'
  );
  assert.equal(back.character_ref_url, undefined);

  const disabled = buildTurnaroundPanelWorkflowData(
    { ...base, turnaround_front_adapter: false },
    TURNAROUND_VIEWS[0]!,
    'prompt',
    'negative',
    '/portrait.png'
  );
  assert.equal(disabled.character_ref_url, undefined);
  assert.equal(disabled.force_no_character_adapter, true);

  const noPortrait = buildTurnaroundPanelWorkflowData(
    base,
    TURNAROUND_VIEWS[0]!,
    'prompt',
    'negative',
    null
  );
  assert.equal(noPortrait.character_ref_url, undefined);
  assert.equal(noPortrait.force_no_character_adapter, true);
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

test('robe turnaround retains covered outfit and excludes decorative background', () => {
  const { prompt, negative_prompt } = buildTurnaroundViewPrompt(
    '1girl, moon-white layered silk robes, black hair',
    TURNAROUND_VIEWS[1]!,
    'pony'
  );
  assert.match(prompt, /shoulders and back fully covered/);
  assert.match(negative_prompt, /strapless gown/);
  assert.match(negative_prompt, /halo|gradient background/);
  assert.match(negative_prompt, /archway/);
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
  assert.equal(meta.width! / meta.height!, 16 / 9);
  assert.equal(meta.format, 'png');
});
