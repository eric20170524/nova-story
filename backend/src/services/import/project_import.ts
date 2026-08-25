import { randomUUID } from 'crypto';
import { db } from '../../db/database';
import type { ParsedTextProject } from '../text_import';
import type { NovelImportDraft } from './types';

export const draftFromTextProject = (
  parsed: ParsedTextProject,
  filename = ''
): NovelImportDraft => ({
  source: {
    filename,
    format: 'text',
  },
  project: {
    title: parsed.title,
    description: parsed.description,
    settings: {},
  },
  chapters: parsed.chapters.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    content: chapter.content,
    status: 'draft',
  })),
  characters: parsed.characters.map((character) => ({ ...character })),
  glossary: [],
  unmappedSections: [],
  warnings: [],
});

export const importNovelDraft = async (
  draft: NovelImportDraft,
  userId: string
) => {
  if (!draft.project.title.trim()) {
    throw new Error('Imported project title cannot be empty');
  }
  if (draft.chapters.length === 0) {
    throw new Error('Imported project must contain at least one chapter');
  }

  await db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await db.run(
      `INSERT INTO project
        (title, description, settings, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      draft.project.title,
      draft.project.description || null,
      JSON.stringify(draft.project.settings || {}),
      userId
    );

    const projectId = result.lastID;
    if (projectId === undefined) {
      throw new Error('Could not create the imported project');
    }

    for (const [arrayIndex, chapter] of draft.chapters.entries()) {
      await db.run(
        `INSERT INTO chapter
          (id, project_id, "index", title, content, summary, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        projectId,
        chapter.index || arrayIndex + 1,
        chapter.title,
        chapter.content || null,
        chapter.summary || null,
        chapter.status || 'draft'
      );
    }

    for (const character of draft.characters) {
      await db.run(
        `INSERT INTO character
          (project_id, name, role, description, visual_tags)
         VALUES (?, ?, ?, ?, ?)`,
        projectId,
        character.name,
        character.role,
        character.description,
        '{}'
      );
    }

    for (const item of draft.glossary) {
      await db.run(
        `INSERT INTO glossary (project_id, term, definition, category)
         VALUES (?, ?, ?, ?)`,
        projectId,
        item.term,
        item.definition ?? null,
        item.category ?? null
      );
    }

    await db.exec('COMMIT');
    return await db.get('SELECT * FROM project WHERE id = ?', projectId);
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
};
