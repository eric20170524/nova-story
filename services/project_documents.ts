import { API_BASE_URL } from '../constants';

export type ProjectDocumentType =
  | 'outline'
  | 'worldbuilding'
  | 'character_notes'
  | 'reference'
  | 'other';

export interface ProjectDocumentSummary {
  id: number;
  project_id: number;
  name: string;
  document_type: ProjectDocumentType;
  source_filename?: string | null;
  source_format: 'text' | 'markdown';
  mime_type?: string | null;
  checksum: string;
  metadata_json?: string | null;
  context_enabled: number | boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectDocumentPreview {
  project: { id: number; title: string };
  document_type: ProjectDocumentType;
  source: {
    filename: string;
    format: 'text' | 'markdown';
    mime_type?: string | null;
  };
  title: string;
  checksum: string;
  content_characters: number;
  line_count: number;
  heading_count: number;
  duplicate_document: ProjectDocumentSummary | null;
  impact: {
    modifies_chapters: false;
    modifies_story_bible: false;
    ai_context_enabled: false;
  };
}

const request = async <T>(url: string, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(options.headers || {});
  const token = localStorage.getItem('access_token');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let detail = `API Error ${response.status}`;
    try {
      const body = await response.json();
      const candidate = body?.detail ?? body?.message ?? body?.error;
      if (candidate) detail = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
    } catch {
      // Keep generic HTTP error for non-JSON responses.
    }
    throw new Error(detail);
  }

  return response.json();
};

const upload = async <T>(
  projectId: number,
  file: File,
  documentType: ProjectDocumentType,
  preview: boolean,
  name?: string
): Promise<T> => {
  const formData = new FormData();
  formData.append('file', file);
  const query = new URLSearchParams({ document_type: documentType });
  if (name?.trim()) query.set('name', name.trim());
  const suffix = preview ? '/preview' : '';
  return request<T>(`/projects/${projectId}/documents${suffix}?${query.toString()}`, {
    method: 'POST',
    body: formData,
  });
};

export const listProjectDocuments = (projectId: number): Promise<ProjectDocumentSummary[]> =>
  request<ProjectDocumentSummary[]>(`/projects/${projectId}/documents`);

export const previewProjectDocument = (
  projectId: number,
  file: File,
  documentType: ProjectDocumentType
): Promise<ProjectDocumentPreview> =>
  upload<ProjectDocumentPreview>(projectId, file, documentType, true);

export const createProjectDocument = (
  projectId: number,
  file: File,
  documentType: ProjectDocumentType,
  name?: string
): Promise<ProjectDocumentSummary> =>
  upload<ProjectDocumentSummary>(projectId, file, documentType, false, name);

export const updateProjectDocumentContext = (
  projectId: number,
  documentId: number,
  enabled: boolean
): Promise<ProjectDocumentSummary> =>
  request<ProjectDocumentSummary>(`/projects/${projectId}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context_enabled: enabled }),
  });

export const deleteProjectDocument = (
  projectId: number,
  documentId: number
): Promise<ProjectDocumentSummary> =>
  request<ProjectDocumentSummary>(`/projects/${projectId}/documents/${documentId}`, {
    method: 'DELETE',
  });
