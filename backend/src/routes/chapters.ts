import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/database';
import { BACKEND_DIRECTORY, getStaticDirectory } from '../core/paths';
import { hashChapterContent, PlanningError } from '../schemas/story_plan';
import { CHAPTER_CONTENT_UNFINALIZE_SQL, StoryPlanService } from '../services/story_plan_service';

const REPO_ROOT = path.resolve(BACKEND_DIRECTORY, '..');

function formatVttTimestamp(seconds: number): string {
  const millis = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hh = String(Math.floor(millis / 3600000)).padStart(2, '0');
  const mm = String(Math.floor(millis / 60000) % 60).padStart(2, '0');
  const ss = String(Math.floor(millis / 1000) % 60).padStart(2, '0');
  const ms = String(millis % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function buildWebVttFromCues(cues: Array<{ block_id?: string; text?: string; start: number; end: number }>): string {
  let number = 0;
  const blocks = (cues || []).flatMap((cue) => {
    const characters = [...String(cue.text || '').replace(/\r?\n/g, ' ')];
    if (!characters.length) return [];
    const pages: string[] = [];
    for (let offset = 0; offset < characters.length; offset += 36) {
      const end = Math.min(offset + 36, characters.length);
      const text = characters.slice(offset, end);
      const lines = text.length > 18 ? `${text.slice(0, 18).join('')}\n${text.slice(18).join('')}` : text.join('');
      const startTime = cue.start + ((cue.end - cue.start) * offset) / characters.length;
      const endTime = cue.start + ((cue.end - cue.start) * end) / characters.length;
      pages.push(`${++number}\n${formatVttTimestamp(startTime)} --> ${formatVttTimestamp(endTime)}\n${lines}`);
    }
    return pages;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

async function buildChapterVideoStatus(chapter: any) {
  const projectId = Number(chapter.project_id);
  const chapterIndex = Number(chapter.index) || 1;
  const chapterId = String(chapter.id);
  const prodDir = path.join(REPO_ROOT, 'local', 'production', String(projectId));
  const prodVideosDir = path.join(prodDir, 'videos');
  const staticChapterDir = path.join(getStaticDirectory(), 'generated', 'projects', String(projectId), 'chapters');
  const baseUrl = `/static/generated/projects/${projectId}/chapters`;

  fs.mkdirSync(staticChapterDir, { recursive: true });

  const prodManifestPath = path.join(prodVideosDir, `chapter-${chapterIndex}.manifest.json`);
  const prodVideoPath = path.join(prodVideosDir, `chapter-${chapterIndex}.mp4`);
  const prodSrtPath = path.join(prodVideosDir, `chapter-${chapterIndex}.srt`);

  const staticVideoPath = path.join(staticChapterDir, `chapter-${chapterIndex}.mp4`);
  const staticSrtPath = path.join(staticChapterDir, `chapter-${chapterIndex}.srt`);
  const staticVttPath = path.join(staticChapterDir, `chapter-${chapterIndex}.vtt`);
  const staticManifestPath = path.join(staticChapterDir, `chapter-${chapterIndex}.manifest.json`);
  const staticByIdPath = path.join(staticChapterDir, `chapter-${chapterId}.json`);

  let manifest: any = null;
  if (fs.existsSync(prodManifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(prodManifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
  } else if (fs.existsSync(staticManifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(staticManifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
  }

  if (fs.existsSync(prodVideoPath)) {
    try {
      const needCopy =
        !fs.existsSync(staticVideoPath) ||
        fs.statSync(prodVideoPath).size !== fs.statSync(staticVideoPath).size ||
        fs.statSync(prodVideoPath).mtimeMs > fs.statSync(staticVideoPath).mtimeMs;
      if (needCopy) {
        fs.copyFileSync(prodVideoPath, staticVideoPath);
      }
    } catch {
      // ignore copy race
    }
  }
  if (fs.existsSync(prodSrtPath)) {
    try {
      fs.copyFileSync(prodSrtPath, staticSrtPath);
    } catch {
      // ignore
    }
  }
  if (manifest?.cues && Array.isArray(manifest.cues)) {
    try {
      fs.writeFileSync(staticVttPath, buildWebVttFromCues(manifest.cues));
    } catch {
      // ignore
    }
  }

  const previewCandidates = [
    { file: `chapter-${chapterIndex}-preview-subtitled.mp4`, label: '阶段带字幕预览片' },
    { file: `chapter-${chapterIndex}-first-10shots-preview.mp4`, label: '前10镜合成预览片' },
  ];
  let previewInfo: { available: boolean; url: string | null; label: string | null } = {
    available: false,
    url: null,
    label: null,
  };
  for (const cand of previewCandidates) {
    const srcPath = path.join(prodVideosDir, cand.file);
    const dstPath = path.join(staticChapterDir, cand.file);
    if (fs.existsSync(srcPath)) {
      try {
        const needCopy =
          !fs.existsSync(dstPath) ||
          fs.statSync(srcPath).size !== fs.statSync(dstPath).size;
        if (needCopy) fs.copyFileSync(srcPath, dstPath);
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(dstPath)) {
      previewInfo = {
        available: true,
        url: `${baseUrl}/${cand.file}`,
        label: cand.label,
      };
      break;
    }
  }

  let reviewRecord: any = null;
  const prodStatePath = path.join(prodDir, 'state.json');
  if (fs.existsSync(prodStatePath)) {
    try {
      const prodState = JSON.parse(fs.readFileSync(prodStatePath, 'utf8'));
      reviewRecord = prodState?.reviews?.chapters?.[chapterId] || null;
    } catch {
      reviewRecord = null;
    }
  }

  const scenes: any[] = await db.all(
    'SELECT * FROM scene WHERE chapter_id = ? ORDER BY "index" ASC, id ASC',
    chapterId
  );

  const shotDurationMap = new Map<number, number>();
  for (const item of manifest?.shot_durations || []) {
    if (item && Number.isFinite(Number(item.scene_id)) && Number.isFinite(Number(item.duration))) {
      shotDurationMap.set(Number(item.scene_id), Number(item.duration));
    }
  }

  let readyVideoShots = 0;
  let anyVideoShots = 0;
  let cursorTime = 0;
  const shotPlaylist = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const activeVersion = Number(scene.active_version) || 1;
    const assets: any[] = await db.all(
      `SELECT * FROM media_asset
       WHERE scene_id = ? AND COALESCE(scene_version, 1) = ?
       ORDER BY id ASC`,
      scene.id,
      activeVersion
    );
    const readyFinal = assets.filter((a) => a.role === 'narrative_final' && a.status === 'ready').at(-1);
    const anyFinal =
      readyFinal ||
      assets.filter((a) => a.role === 'narrative_final' && a.status !== 'archived' && a.status !== 'rejected').at(-1) ||
      assets.filter((a) => a.role === 'loop_master' && a.status !== 'archived' && a.status !== 'rejected').at(-1) ||
      assets.filter((a) => a.role === 'raw_video' && a.status !== 'archived' && a.status !== 'rejected').at(-1) ||
      null;
    const posterAsset = assets.filter((a) => a.role === 'poster').at(-1);

    if (readyFinal) readyVideoShots += 1;
    if (anyFinal) anyVideoShots += 1;

    const durationFromAsset =
      anyFinal?.duration_ms && Number(anyFinal.duration_ms) > 0
        ? Number(anyFinal.duration_ms) / 1000
        : null;
    const shotDuration =
      shotDurationMap.get(Number(scene.id)) ??
      durationFromAsset ??
      (Number(scene.duration) > 0 ? Number(scene.duration) : 5);

    const startTime = Number(cursorTime.toFixed(3));
    const endTime = Number((cursorTime + shotDuration).toFixed(3));
    cursorTime = endTime;

    shotPlaylist.push({
      scene_id: Number(scene.id),
      shot_number: i + 1,
      duration: shotDuration,
      start_time: startTime,
      end_time: endTime,
      video_url: anyFinal?.url || null,
      video_role: anyFinal?.role || null,
      video_status: anyFinal?.status || null,
      poster_url: posterAsset?.url || scene.asset_url || null,
      dialogue: scene.dialogue || '',
      narration: scene.narration || '',
      visual_prompt: scene.visual_prompt || '',
    });
  }

  const assembledAvailable = fs.existsSync(staticVideoPath);
  const vttAvailable = fs.existsSync(staticVttPath);
  const srtAvailable = fs.existsSync(staticSrtPath);

  const payload = {
    project_id: projectId,
    chapter_id: chapterId,
    chapter_index: chapterIndex,
    chapter_title: chapter.title || `第${chapterIndex}章`,
    assembled: {
      available: assembledAvailable,
      url: assembledAvailable ? `${baseUrl}/chapter-${chapterIndex}.mp4` : null,
      subtitle_url: srtAvailable ? `${baseUrl}/chapter-${chapterIndex}.srt` : null,
      vtt_url: vttAvailable ? `${baseUrl}/chapter-${chapterIndex}.vtt` : null,
      duration: manifest?.duration ?? (assembledAvailable ? cursorTime : null),
      sha256: manifest?.sha256 ?? null,
      subtitle_sha256: manifest?.subtitle_sha256 ?? null,
      created_at: manifest?.created_at ?? null,
      cues: Array.isArray(manifest?.cues) ? manifest.cues : [],
      shot_durations: Array.isArray(manifest?.shot_durations) ? manifest.shot_durations : [],
    },
    preview: previewInfo,
    review: reviewRecord,
    shots_summary: {
      total_shots: scenes.length,
      ready_video_shots: readyVideoShots,
      any_video_shots: anyVideoShots,
      all_ready: scenes.length > 0 && readyVideoShots === scenes.length,
    },
    shot_playlist: shotPlaylist,
    updated_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(staticByIdPath, JSON.stringify(payload, null, 2));
  } catch {
    // ignore
  }

  return payload;
}

const ChapterCreateSchema = z.object({
  id: z.string().min(1),
  project_id: z.coerce.number().int(),
  index: z.coerce.number().int(),
  title: z.string().min(1),
  content: z.string().nullable().optional()
});

const ChapterUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  status: z.string().optional(),
  condensed_content: z.string().nullable().optional(),
});

const ChapterIdSchema = z.object({
  id: z.string().min(1)
});

export const chapterRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request) => {
    const { project_id } = z.object({
      project_id: z.coerce.number().int()
    }).parse(request.query);

    return db.all(
      'SELECT * FROM chapter WHERE project_id = ? ORDER BY "index" ASC',
      project_id
    );
  });

  app.post('/', async (request, reply) => {
    const chapter = ChapterCreateSchema.parse(request.body);
    try {
      const created = await StoryPlanService.createManualChapter({
        projectId: chapter.project_id,
        id: chapter.id,
        title: chapter.title,
        content: chapter.content,
      });
      return reply.status(201).send(created);
    } catch (error) {
      if (error instanceof PlanningError && error.code === 'PREVIOUS_CHAPTER_NOT_FINALIZED') {
        return reply.status(400).send({ detail: error.message });
      }
      if (error instanceof PlanningError && error.code === 'PROJECT_NOT_FOUND') {
        return reply.status(404).send({ detail: 'Project not found' });
      }
      if (error instanceof PlanningError) {
        return reply.status(error.status).send({ code: error.code, detail: error.message });
      }
      throw error;
    }
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const update = ChapterUpdateSchema.parse(request.body);
    const existing = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!existing) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const contentChanged = update.content !== undefined && update.content !== existing.content;
    const outlineChanged = update.title !== undefined || update.summary !== undefined;
    const completeWithoutContentChange = update.status === 'completed' && !contentChanged;

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (update.title !== undefined) {
        fields.push('title = ?');
        values.push(update.title);
      }
      if (update.summary !== undefined) {
        fields.push('summary = ?');
        values.push(update.summary);
      }
      if (update.condensed_content !== undefined) {
        fields.push('condensed_content = ?');
        values.push(update.condensed_content);
      }
      if (contentChanged) {
        fields.push('content = ?');
        values.push(update.content);
        fields.push(CHAPTER_CONTENT_UNFINALIZE_SQL);
      } else if (completeWithoutContentChange) {
        fields.push('status = ?');
        values.push('completed');
        fields.push('finalized_content_hash = ?');
        values.push(hashChapterContent(existing.content));
      } else if (update.status !== undefined) {
        fields.push('status = ?');
        values.push(update.status);
      }
      if (fields.length > 0) {
        await db.run(
          `UPDATE chapter SET ${fields.join(', ')} WHERE id = ?`,
          ...values,
          id
        );
      }
      if (outlineChanged) {
        await StoryPlanService.syncLinkedOutlineUnlocked(existing.project_id, id);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      if (error instanceof PlanningError) {
        return reply.status(error.status).send({ code: error.code, detail: error.message });
      }
      throw error;
    }

    return db.get('SELECT * FROM chapter WHERE id = ?', id);
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const existing = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!existing) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      await db.run(
        `DELETE FROM script_change
         WHERE script_id IN (
           SELECT id FROM chapter_script WHERE chapter_id = ?
         )`,
        id
      );
      await db.run('DELETE FROM chapter_script WHERE chapter_id = ?', id);

      await db.run(
        `DELETE FROM coverage_shot
         WHERE coverage_group_id IN (
           SELECT coverage_group.id
           FROM coverage_group
           INNER JOIN scene ON scene.id = coverage_group.source_scene_id
           WHERE scene.chapter_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM coverage_group
         WHERE source_scene_id IN (
           SELECT id FROM scene WHERE chapter_id = ?
         )`,
        id
      );
      await db.run(
        `DELETE FROM scene_version
         WHERE scene_id IN (
           SELECT id FROM scene WHERE chapter_id = ?
         )`,
        id
      );
      await db.run('DELETE FROM scene WHERE chapter_id = ?', id);
      await StoryPlanService.retireLinkedChapter(existing.project_id, id);
      const project = await db.get('SELECT settings FROM project WHERE id = ?', existing.project_id);
      if (project) {
        const { dropChapterImpact } = await import('../services/story_bible');
        const { parseProjectSettings } = await import('../services/project_settings');
        const nextSettings = dropChapterImpact(parseProjectSettings(project.settings), id);
        await db.run(
          'UPDATE project SET settings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          JSON.stringify(nextSettings),
          existing.project_id
        );
      }
      await db.run('DELETE FROM chapter WHERE id = ?', id);
      await db.exec('COMMIT');
      return { status: 'success', id };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });

  app.put('/:id/move', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const { new_index } = z.object({
      new_index: z.coerce.number().int().min(0)
    }).parse(request.body);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', id);

    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }
    if (chapter.index === new_index) {
      return { status: 'no_change', new_index };
    }

    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      if (new_index > chapter.index) {
        await db.run(
          'UPDATE chapter SET "index" = "index" - 1 WHERE project_id = ? AND id <> ? AND "index" > ? AND "index" <= ?',
          chapter.project_id,
          id,
          chapter.index,
          new_index
        );
      } else {
        await db.run(
          'UPDATE chapter SET "index" = "index" + 1 WHERE project_id = ? AND id <> ? AND "index" >= ? AND "index" < ?',
          chapter.project_id,
          id,
          new_index,
          chapter.index
        );
      }

      await db.run('UPDATE chapter SET "index" = ? WHERE id = ?', new_index, id);
      await StoryPlanService.reorderFromChapters(chapter.project_id);
      await db.exec('COMMIT');
      return { status: 'moved', new_index };
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  });

  app.get('/:id/video', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }
    return buildChapterVideoStatus(chapter);
  });

  app.post('/:id/video/assemble', async (request, reply) => {
    const { id } = ChapterIdSchema.parse(request.params);
    const chapter = await db.get('SELECT * FROM chapter WHERE id = ?', id);
    if (!chapter) {
      return reply.status(404).send({ detail: 'Chapter not found' });
    }

    const totalChaptersRow = await db.get(
      'SELECT COUNT(*) as count FROM chapter WHERE project_id = ?',
      chapter.project_id
    );
    const chapterLimit = Math.max(
      Number(chapter.index) || 1,
      Number(totalChaptersRow?.count) || 3
    );
    const hostHeader = request.headers.host || '127.0.0.1:3000';
    const baseUrl = `http://${hostHeader}`;
    const scriptPath = path.join(REPO_ROOT, 'scripts', 'full-production.mjs');

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          scriptPath,
          '--project',
          String(chapter.project_id),
          '--chapter-limit',
          String(chapterLimit),
          '--base-url',
          baseUrl,
          '--stage',
          'assemble',
          '--chapter-id',
          String(chapter.id),
          '--auto-approve',
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let stderr = '';
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              (stderr || stdout || `Chapter assembly failed with exit code ${code}`).trim()
            )
          );
        }
      });
    }).catch((error: any) => {
      return reply.status(400).send({
        detail: error?.message || 'Failed to assemble chapter video',
      });
    });

    if (reply.sent) return;
    return buildChapterVideoStatus(chapter);
  });
};
