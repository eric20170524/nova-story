import path from 'path';

export interface NovaStoryJsonImportChapter {
  sourceId?: string;
  index: number;
  title: string;
  content: string | null;
  summary: string | null;
  status: string;
  planEntryId?: string | null;
  targetWordCount?: number | null;
  finalizedContentHash?: string | null;
}

export interface NovaStoryJsonImportCharacter {
  sourceId?: string;
  name: string;
  role: string | null;
  description: string | null;
  visualTags: string;
}

export interface NovaStoryJsonImportScriptChange {
  id?: string;
  kind: string;
  baseRevision: number;
  candidateRevision: number;
  requestKey: string;
  state: string;
  beforeJson: string | null;
  afterJson: string | null;
  sourceSnapshotJson: string | null;
  generationInfoJson: string | null;
  appliedRevision: number | null;
  resultJson: string | null;
}

export interface NovaStoryJsonImportScript {
  sourceId?: string;
  sourceChapterId: string;
  revision: number;
  status: string;
  document: Record<string, any>;
  sourceSnapshot: Record<string, any> | null;
  sourceContentHash: string;
  sourceContextHash: string;
  changes: NovaStoryJsonImportScriptChange[];
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

export interface NovaStoryJsonImportGlossaryItem {
  term: string;
  definition: string | null;
  category: string | null;
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
  glossary: NovaStoryJsonImportGlossaryItem[];
  /** True when the file contained a glossary array, including an empty one. */
  glossaryProvided: boolean;
  chapters: NovaStoryJsonImportChapter[];
  characters: NovaStoryJsonImportCharacter[];
  scripts: NovaStoryJsonImportScript[];
  scenes: NovaStoryJsonImportScene[];
  coverageGroups: NovaStoryJsonImportCoverageGroup[];
  coverageShots: NovaStoryJsonImportCoverageShot[];
  storyPlan: { revision: number; document: Record<string, unknown> } | null;
  assetLibrary?: unknown;
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

const optionalRevision = (primary: unknown, secondary: unknown): number | null => {
  const value = primary !== undefined ? primary : secondary;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
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
  let glossaryProvided = false;
  const glossary: NovaStoryJsonImportGlossaryItem[] = [];
  if (Object.prototype.hasOwnProperty.call(jsonContent, 'glossary')) {
    if (Array.isArray(jsonContent.glossary)) {
      glossaryProvided = true;
      for (const [arrayIndex, raw] of jsonContent.glossary.entries()) {
        if (!isRecord(raw) || typeof raw.term !== 'string' || !raw.term.trim()) {
          warnings.push(`Glossary item ${arrayIndex + 1} had no term and was skipped`);
          continue;
        }
        glossary.push({
          term: raw.term.trim().slice(0, 200),
          definition: optionalText(raw.definition),
          category: optionalText(raw.category),
        });
      }
    } else if (jsonContent.glossary !== null) {
      warnings.push('Glossary was not an array and was ignored');
    }
  }
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
  const rawScripts = arrayFrom(
    screenplay.scripts,
    jsonContent.scripts,
    'Scripts',
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
      planEntryId: optionalText(raw.plan_entry_id),
      targetWordCount: raw.target_word_count == null ? null : finiteNumber(raw.target_word_count, 0) || null,
      finalizedContentHash: optionalText(raw.finalized_content_hash),
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
      sourceId: optionalId(raw.id),
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

  const scripts: NovaStoryJsonImportScript[] = [];
  for (const [arrayIndex, raw] of rawScripts.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Script ${arrayIndex + 1} was not an object and was skipped`);
      continue;
    }

    const sourceChapterId = optionalId(raw.chapter_id ?? raw.sourceChapterId);
    if (!sourceChapterId || !chapterIds.has(sourceChapterId)) {
      warnings.push(`Script ${arrayIndex + 1} referenced a missing chapter and was skipped`);
      continue;
    }

    const rawChanges = Array.isArray(raw.changes) ? raw.changes : [];
    const changes: NovaStoryJsonImportScriptChange[] = [];
    for (const ch of rawChanges) {
      if (!isRecord(ch)) continue;
      changes.push({
        id: optionalId(ch.id),
        kind: typeof ch.kind === 'string' ? ch.kind : 'manual',
        baseRevision: finiteNumber(ch.base_revision ?? ch.baseRevision, 1),
        candidateRevision: finiteNumber(ch.candidate_revision ?? ch.candidateRevision, 1),
        requestKey: typeof ch.request_key === 'string' ? ch.request_key : (typeof ch.requestKey === 'string' ? ch.requestKey : `import_${arrayIndex}`),
        state: typeof ch.state === 'string' ? ch.state : 'applied',
        beforeJson: jsonText(ch.before_json ?? ch.beforeJson, null),
        afterJson: jsonText(ch.after_json ?? ch.afterJson, null),
        sourceSnapshotJson: jsonText(ch.source_snapshot_json ?? ch.sourceSnapshotJson, null),
        generationInfoJson: jsonText(ch.generation_info_json ?? ch.generationInfoJson, null),
        appliedRevision: optionalRevision(ch.applied_revision, ch.appliedRevision),
        resultJson: jsonText(ch.result_json ?? ch.resultJson, null),
      });
    }

    let parsedDoc: Record<string, any> = {};
    if (isRecord(raw.document)) {
      parsedDoc = raw.document;
    } else if (typeof raw.document_json === 'string') {
      try {
        parsedDoc = JSON.parse(raw.document_json);
      } catch {
        parsedDoc = {};
      }
    }

    let parsedSnapshot: Record<string, any> | null = null;
    if (isRecord(raw.source_snapshot)) {
      parsedSnapshot = raw.source_snapshot;
    } else if (isRecord(raw.sourceSnapshot)) {
      parsedSnapshot = raw.sourceSnapshot;
    } else if (typeof raw.source_snapshot_json === 'string') {
      try {
        parsedSnapshot = JSON.parse(raw.source_snapshot_json);
      } catch {
        parsedSnapshot = null;
      }
    }

    scripts.push({
      sourceId: optionalId(raw.id),
      sourceChapterId,
      revision: finiteNumber(raw.revision, 1),
      status: typeof raw.status === 'string' && raw.status.trim() ? raw.status.trim() : 'draft',
      document: parsedDoc,
      sourceSnapshot: parsedSnapshot,
      sourceContentHash: typeof raw.source_content_hash === 'string' ? raw.source_content_hash : (typeof raw.sourceContentHash === 'string' ? raw.sourceContentHash : ''),
      sourceContextHash: typeof raw.source_context_hash === 'string' ? raw.source_context_hash : (typeof raw.sourceContextHash === 'string' ? raw.sourceContextHash : ''),
      changes,
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
    glossary,
    glossaryProvided,
    chapters,
    characters,
    scripts,
    scenes,
    coverageGroups,
    coverageShots,
    storyPlan: readStoryPlan(jsonContent, warnings),
    assetLibrary: jsonContent.asset_library,
    warnings,
  };
};

function readStoryPlan(jsonContent: Record<string, any>, warnings: string[]) {
  if (jsonContent.story_plan == null) return null;
  if (!isRecord(jsonContent.story_plan) || !isRecord(jsonContent.story_plan.document)) {
    warnings.push('story_plan was not an object and was ignored');
    return null;
  }
  return {
    revision: finiteNumber(jsonContent.story_plan.revision, 1),
    document: jsonContent.story_plan.document,
  };
}
