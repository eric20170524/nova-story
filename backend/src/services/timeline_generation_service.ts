/**
 * Shared chapter → narrative timeline generation.
 * Used by POST /timeline/generate and Agent OS GENERATE_TIMELINE so both paths
 * share transactions, scene_version baselines, and character profile wiring.
 */
import { db } from '../db/database';
import { LLMService } from './llm';
import { SettingsManager } from '../core/settings_manager';
import { parseProjectSettings, resolveEffectiveNsfw } from './project_settings';
import {
  annotateSceneWithVersions,
  ensureSceneVersionBaseline,
} from './scene_versions';

export async function buildCharacterProfilesForChapter(
  projectId: number,
  chapterId: string
): Promise<string> {
  const characters = await db.all(
    'SELECT * FROM character WHERE project_id = ?',
    projectId
  );
  if (!characters?.length) return '';

  const profiles = characters.map((c: any) => {
    let tags =
      typeof c.visual_tags === 'string'
        ? JSON.parse(c.visual_tags || '{}')
        : c.visual_tags || {};
    let tagStr = '';

    if (tags && tags.base_model) {
      let baseTags = tags.base_model.tags || {};
      if (typeof baseTags === 'string') baseTags = { base: baseTags };
      let activeVariantTags: Record<string, unknown> = {};

      const timelineMap = tags.timeline_map || {};
      let activeVariantId = timelineMap[chapterId];
      const variants = tags.variants || [];

      if (!activeVariantId && variants.length > 0) {
        activeVariantId = variants[0].id;
      }

      if (activeVariantId) {
        const variant = variants.find((v: any) => v.id === activeVariantId);
        if (variant) {
          activeVariantTags = variant.tags || {};
          if (typeof activeVariantTags === 'string') {
            activeVariantTags = { variant: activeVariantTags };
          }
        }
      }

      const combined = { ...baseTags, ...activeVariantTags };
      tagStr = Object.entries(combined)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
    } else if (tags) {
      tagStr = Object.entries(tags)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
    }

    return `- Name: ${c.name}\n  Description: ${c.description}\n  Visual Tags: ${tagStr}`;
  });

  return profiles.join('\n');
}

/**
 * Replace chapter scenes with LLM narrative storyboard inside a transaction.
 * Each new scene gets a scene_version baseline (same as timeline route).
 */
export async function generateAndReplaceNarrativeTimeline(options: {
  chapterId: string;
  projectId: number;
  content: string;
  mode?: string;
}): Promise<{ chapter_id: string; storyboard_mode: string; timeline: any[]; count: number }> {
  const mode = (options.mode || 'narrative').toLowerCase();
  if (['cinematic_grid', 'nine_shot_coverage'].includes(mode)) {
    throw new Error(
      "Chapter-level nine_shot_coverage is deprecated. Use per-scene coverage instead."
    );
  }
  if (!['narrative', 'standard'].includes(mode)) {
    throw new Error(
      `Invalid mode '${options.mode}'. Only 'narrative' is supported for auto-storyboard.`
    );
  }
  if (!options.content?.trim()) {
    throw new Error('Chapter has no content');
  }

  const charProfilesStr = await buildCharacterProfilesForChapter(
    options.projectId,
    options.chapterId
  );

  const project = await db.get(
    'SELECT settings FROM project WHERE id = ?',
    options.projectId
  );
  const projectSettings = parseProjectSettings(project?.settings);
  const nsfwEnabled = resolveEffectiveNsfw({
    systemNsfwEnabled: Boolean(
      SettingsManager.loadSettings()?.advanced?.nsfw_enabled
    ),
    projectSettings,
  });

  const timelineData = await LLMService.generateTimeline(
    options.content,
    charProfilesStr,
    'narrative',
    undefined,
    { nsfwEnabled }
  );

  if (!timelineData || timelineData.length === 0) {
    throw new Error('LLM returned empty timeline data');
  }

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    // Clean coverage trees for existing scenes (legacy DBs may lack CASCADE)
    await db.run(
      `DELETE FROM coverage_shot
       WHERE coverage_group_id IN (
         SELECT coverage_group.id
         FROM coverage_group
         INNER JOIN scene ON scene.id = coverage_group.source_scene_id
         WHERE scene.chapter_id = ?
       )`,
      options.chapterId
    );
    await db.run(
      `DELETE FROM coverage_group
       WHERE source_scene_id IN (
         SELECT id FROM scene WHERE chapter_id = ?
       )`,
      options.chapterId
    );
    await db.run('DELETE FROM scene WHERE chapter_id = ?', options.chapterId);

    const newScenes: any[] = [];
    for (let i = 0; i < timelineData.length; i++) {
      const item = timelineData[i];
      const result = await db.run(
        `INSERT INTO scene (
           chapter_id, "index", visual_prompt, audio_prompt, dialogue, duration,
           shot_type, camera_movement, camera_angle, negative_prompt, asset_status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
        options.chapterId,
        i + 1,
        item.visual_prompt || '',
        item.audio_prompt || '',
        item.dialogue || '',
        item.duration || 3.0,
        item.shot_type || '',
        item.camera_movement || '',
        item.camera_angle || '',
        item.negative_prompt || null
      );

      const newScene = await db.get(
        'SELECT * FROM scene WHERE id = ?',
        result.lastID
      );
      if (newScene) {
        await ensureSceneVersionBaseline(newScene.id);
        newScenes.push(await annotateSceneWithVersions(newScene));
      }
    }

    await db.exec('COMMIT');

    return {
      chapter_id: options.chapterId,
      storyboard_mode: 'narrative',
      timeline: newScenes,
      count: newScenes.length,
    };
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
