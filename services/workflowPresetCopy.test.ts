import assert from 'node:assert/strict';
import test from 'node:test';
import { translations } from '../locales';
import { PROJECT_VIDEO_WORKFLOW_IDS } from './videoWorkflowPolicy';

const imagePresets = [
  'pony_xl_12gb',
  'autismmix_pony_l40',
  'pony_xl_baseline_l40',
  'pony_xl_tier_b_dual_ref_l40',
  'animagine_xl_4_l40',
  'sd15_draft_12gb',
  'redcraft_krea2_12gb',
];

test('workflow preset blurbs exist in English and Chinese', () => {
  for (const language of ['en', 'zh'] as const) {
    const workflow = translations[language].workflow;
    for (const name of imagePresets) {
      assert.equal(typeof workflow.presets[name as keyof typeof workflow.presets], 'string', `${language} image ${name}`);
    }
    for (const id of PROJECT_VIDEO_WORKFLOW_IDS) {
      assert.equal(typeof workflow.video_presets[id], 'string', `${language} video ${id}`);
      assert.equal(typeof translations[language].project_settings[`video_${id}`], 'string');
    }
    assert.ok(workflow.catalog_intro.length > 20);
    assert.ok(workflow.image_section_desc.length > 20);
    assert.ok(workflow.video_section_desc.length > 20);
  }
});
