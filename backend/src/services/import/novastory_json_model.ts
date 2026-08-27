import path from 'path';

export interface NovaStoryJsonImportChapter {
  sourceId?: string;
  index: number;
  title: string;
  content: string | null;
  summary: string | null;
  status: string;
}

export interface NovaStoryJsonImportCharacter {
  name: string;
  role: string | null;
  description: string | null;
  visualTags: string;
}

export interface NovaStoryJsonImportScene {
  sourceId?: string;
  sourceChapterId: string;
  index: number;
  visualPrompt: string | null;
  audioPrompt: string | null;
  dialogue: string | null;
  narration: string | null;
  duration: number;
  shotType: string | null;
  cameraMovement: string | null;
  cameraAngle: string | null;
  negativePrompt: string | null;
  shotSpec: string | null;
  assetStatus: string;
  taskId: string | null;
  assetUrl: string | null;
}

export interface NovaStoryJsonImportCoverageGroup {
  sourceId?: string;
  sourceSceneId: string;
  version: number;
  status: string;
}

export interface NovaStoryJsonImportCoverageShot {
  sourceCoverageGroupId: string;
  slot: number;
  shotSize: string | null;
  cameraAngle: string | null;
  cameraMovement: string | null;
  narrativePurpose: string | null;
  visualPrompt: string | null;
  negativePrompt: string | null;
  shotSpec: string | null;
  shotIntent: string | null;
  assetStatus: string;
  taskId: string | null;
  assetUrl: string | null;
}

export interface NovaStoryJsonImportProject {
  source: {
    filename: string;
    format: 'json';
  };
  project: {
    title: string;
    description: string | null;
    settings: Record<string, unknown>;
  };
  chapters: NovaStoryJsonImportChapter[];
  characters: NovaStoryJsonImportCharacter[];
  scenes: NovaStoryJsonImportScene[];
  coverageGroups: NovaStoryJsonImportCoverageGroup[];
  coverageShots: NovaStoryJsonImportCoverageShot[];
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, any> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const optionalId = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value).trim();
  return id || undefined;
};

const optionalText = (value: unknown): string | null => (
  typeof value === 'string' ? value : null
);

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const jsonText = (value: unknown, fallback: string | null): string | null => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
};

const normalizeSettings = (
  value: unknown,
  warnings: string[]
): Record<string, unknown> => {
  if (isRecord(value)) return { ...value };

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
      warnings.push('Project settings were not a JSON object and were replaced with empty settings');
      return {};
    } catch {
      warnings.push('Project settings contained malformed JSON and were replaced with empty settings');
      return {};
    }
  }

  if (value !== undefined && value !== null) {
    warnings.push('Project settings were not an object and were replaced with empty settings');
  }
  return {};
};

const hasRecognizedProjectShape = (value: Record<string, any>): boolean => [
  'format',
  'project',
  'title',
  'screenplay',
  'chapters',
  'character_center',
  'characters',
  'director',
].some((key) => Object.prototype.hasOwnProperty.call(value, key));

const arrayFrom = (
  primary: unknown,
  fallback: unknown,
  label: string,
  warnings: string[]
): unknown[] => {
  if (Array.isArray(primary)) return primary;
  if (Array.isArray(fallback)) return fallback;
  if (primary !== undefined && primary !== null) {
    warnings.push(`${label} was not an array and was ignored`);
  } else if (fallback !== undefined && fallback !== null) {
    warnings.push(`${label} was not an array and was ignored`);
  }
  return [];
};

const registerUniqueId = (
  seen: Set<string>,
  value: unknown,
  label: string
): string | undefined => {
  const id = optionalId(value);
  if (!id) return undefined;
  if (seen.has(id)) {
    throw new Error(`Duplicate ${label} id "${id}" makes project references ambiguous`);
  }
  seen.add(id);
  return id;
};

/**
 * Build one deterministic, database-free Native JSON import plan.
 * Preview and persistence both consume this exact plan, so counts, warnings,
 * reference filtering, and value normalization cannot drift apart.
 */
export const normalizeNovaStoryJsonProject = (
  jsonContent: Record<string, any>,
  filename = ''
): NovaStoryJsonImportProject => {
  if (!hasRecognizedProjectShape(jsonContent)) {
    throw new Error('The JSON file does not look like a NovaStory project or generic project export');
  }

  const warnings: string[] = [];
  const projectRecord = isRecord(jsonContent.project) ? jsonContent.project : {};
  if (jsonContent.project !== undefined && !isRecord(jsonContent.project)) {
    warnings.push('Project metadata was not an object and was partially ignored');
  }

  const ext = path.extname(filename).toLowerCase();
  const fallbackTitle = path.basename(filename, ext).trim() || 'Imported Project';
  const rawTitle = projectRecord.title ?? jsonContent.title;
  const title = typeof rawTitle === 'string' && rawTitle.trim()
    ? rawTitle.trim().slice(0, 255)
    : fallbackTitle.slice(0, 255);
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    warnings.push('Project title was not text; the filename was used instead');
  }

  const rawDescription = projectRecord.description ?? jsonContent.description;
  const description = optionalText(rawDescription);
  if (rawDescription !== undefined && rawDescription !== null && description === null) {
    warnings.push('Project description was not text and was ignored');
  }

  const settings = normalizeSettings(projectRecord.settings, warnings);
  const screenplay = isRecord(jsonContent.screenplay) ? jsonContent.screenplay : {};
  const characterCenter = isRecord(jsonContent.character_center)
    ? jsonContent.character_center
    : {};
  const director = isRecord(jsonContent.director) ? jsonContent.director : {};
  if (jsonContent.director !== undefined && !isRecord(jsonContent.director)) {
    warnings.push('Director data was not an object and was ignored');
  }

  const rawChapters = arrayFrom(
    screenplay.chapters,
    jsonContent.chapters,
    'Chapters',
    warnings
  );
  const rawCharacters = arrayFrom(
    characterCenter.characters,
    jsonContent.characters,
    'Characters',
    warnings
  );
  const rawScenes = arrayFrom(director.scenes, undefined, 'Scenes', warnings);
  const rawCoverageGroups = arrayFrom(
    director.coverage_groups,
    undefined,
    'Coverage groups',
    warnings
  );
  const rawCoverageShots = arrayFrom(
    director.coverage_shots,
    undefined,
    'Coverage shots',
    warnings
  );

  const chapterIds = new Set<string>();
  const chapters: NovaStoryJsonImportChapter[] = [];
  for (const [arrayIndex, raw] of rawChapters.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Chapter ${arrayIndex + 1} was not an object and was skipped`);
      continue;
    }

    const sourceId = registerUniqueId(chapterIds, raw.id, 'chapter');
    const rawContent = raw.content;
    const rawSummary = raw.summary;
    if (rawContent !== undefined && rawContent !== null && typeof rawContent !== 'string') {
      warnings.push(`Chapter ${arrayIndex + 1} content was not text and was ignored`);
    }
    if (rawSummary !== undefined && rawSummary !== null && typeof rawSummary !== 'string') {
      warnings.push(`Chapter ${arrayIndex + 1} summary was not text and was ignored`);
    }

    chapters.push({
      sourceId,
      index: finiteNumber(raw.index, arrayIndex + 1),
      title: typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim().slice(0, 255)
        : `Chapter ${arrayIndex + 1}`,
      content: optionalText(rawContent),
      summary: optionalText(rawSummary),
      status: typeof raw.status === 'string' && raw.status.trim()
        ? raw.status.trim()
        : 'draft',
    });
  }

  const characters: NovaStoryJsonImportCharacter[] = [];
  for (const [arrayIndex, raw] of rawCharacters.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Character ${arrayIndex + 1} was not an object and was skipped`);
      continue;
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      warnings.push(`Character ${arrayIndex + 1} had no explicit name and was skipped`);
      continue;
    }

    characters.push({
      name: raw.name.trim().slice(0, 255),
      role: optionalText(raw.role),
      description: optionalText(raw.description),
      visualTags: jsonText(raw.visual_tags, '{}') || '{}',
    });
  }

  const sceneIds = new Set<string>();
  const scenes: NovaStoryJsonImportScene[] = [];
  for (const [arrayIndex, raw] of rawScenes.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Scene ${arrayIndex + 1} was not an object and was skipped`);
      continue;
    }

    const sourceChapterId = optionalId(raw.chapter_id);
    if (!sourceChapterId || !chapterIds.has(sourceChapterId)) {
      warnings.push(`Scene ${arrayIndex + 1} referenced a missing chapter and was skipped`);
      continue;
    }

    const sourceId = registerUniqueId(sceneIds, raw.id, 'scene');
    scenes.push({
      sourceId,
      sourceChapterId,
      index: finiteNumber(raw.index, arrayIndex + 1),
      visualPrompt: optionalText(raw.visual_prompt),
      audioPrompt: optionalText(raw.audio_prompt),
      dialogue: optionalText(raw.dialogue),
      narration: optionalText(raw.narration),
      duration: finiteNumber(raw.duration, 3),
      shotType: optionalText(raw.shot_type),
      cameraMovement: optionalText(raw.camera_movement),
      cameraAngle: optionalText(raw.camera_angle),
      negativePrompt: optionalText(raw.negative_prompt),
      shotSpec: jsonText(raw.shot_spec, null),
      assetStatus: typeof raw.asset_status === 'string' && raw.asset_status.trim()
        ? raw.asset_status.trim()
        : 'idle',
      taskId: optionalText(raw.task_id),
      assetUrl: optionalText(raw.asset_url),
    });
  }

  const coverageGroupIds = new Set<string>();
  const coverageGroups: NovaStoryJsonImportCoverageGroup[] = [];
  for (const [arrayIndex, raw] of rawCoverageGroups.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Coverage group ${arrayIndex + 1} was not an object and was skipped`);
      continue;
    }

    const sourceSceneId = optionalId(raw.source_scene_id);
    if (!sourceSceneId || !sceneIds.has(sourceSceneId)) {
      warnings.push(`Coverage group ${arrayIndex + 1} referenced a missing scene and was skipped`);
      continue;
    }

    const sourceId = registerUniqueId(coverageGroupIds, raw.id, 'coverage group');
    coverageGroups.push({
      sourceId,
      sourceSceneId,
      version: finiteNumber(raw.version, 1),
      status: typeof raw.status === 'string' && raw.status.trim()
        ? raw.status.trim()
        : 'completed',
    });
  }

  const coverageShots: NovaStoryJsonImportCoverageShot[] = [];
  for (const [arrayIndex, raw] of rawCoverageShots.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Coverage shot ${arrayIndex + 1} was not an object and was skipped`);
      continue;
    }

    const sourceCoverageGroupId = optionalId(raw.coverage_group_id);
    if (!sourceCoverageGroupId || !coverageGroupIds.has(sourceCoverageGroupId)) {
      warnings.push(`Coverage shot ${arrayIndex + 1} referenced a missing coverage group and was skipped`);
      continue;
    }

    coverageShots.push({
      sourceCoverageGroupId,
      slot: finiteNumber(raw.slot, arrayIndex + 1),
      shotSize: optionalText(raw.shot_size),
      cameraAngle: optionalText(raw.camera_angle),
      cameraMovement: optionalText(raw.camera_movement),
      narrativePurpose: optionalText(raw.narrative_purpose),
      visualPrompt: optionalText(raw.visual_prompt),
      negativePrompt: optionalText(raw.negative_prompt),
      shotSpec: optionalText(raw.shot_spec),
      shotIntent: optionalText(raw.shot_intent),
      assetStatus: typeof raw.asset_status === 'string' && raw.asset_status.trim()
        ? raw.asset_status.trim()
        : 'idle',
      taskId: optionalText(raw.task_id),
      assetUrl: optionalText(raw.asset_url),
    });
  }

  if (chapters.length === 0) {
    warnings.push('The JSON project contains no restorable chapters');
  }

  return {
    source: {
      filename,
      format: 'json',
    },
    project: {
      title,
      description,
      settings,
    },
    chapters,
    characters,
    scenes,
    coverageGroups,
    coverageShots,
    warnings,
  };
};
