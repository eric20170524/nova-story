import { API_BASE_URL } from '../constants';

export interface ProjectImportPreviewChapter {
  index: number;
  title: string;
  summary?: string;
  has_content: boolean;
  content_characters: number;
}

export interface ProjectImportPreview {
  source: {
    filename: string;
    format: 'text' | 'markdown' | 'json';
  };
  mode: 'novel-draft' | 'novastory-project';
  project: {
    title: string;
    description?: string | null;
    settings: Record<string, unknown>;
  };
  chapters: ProjectImportPreviewChapter[];
  counts: {
    chapters: number;
    chapter_summaries: number;
    chapter_contents: number;
    characters: number;
    glossary: number;
    scenes: number;
    coverage_groups: number;
    coverage_shots: number;
  };
  warnings: string[];
  unmapped_sections: Array<{
    heading: string;
    content: string;
    scope: 'project' | 'chapter';
    chapterTitle?: string;
  }>;
}

export const previewProjectImport = async (file: File): Promise<ProjectImportPreview> => {
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  const token = localStorage.getItem('access_token');
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}/projects/import/preview`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    let detail = `API Error ${response.status}`;
    try {
      const body = await response.json();
      if (body?.detail) {
        detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
      }
    } catch {
      // Preserve the generic HTTP error when the backend response is not JSON.
    }
    throw new Error(detail);
  }

  return response.json();
};
