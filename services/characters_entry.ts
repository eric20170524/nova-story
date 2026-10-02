export const LAST_PROJECT_STORAGE_KEY = 'novastory_last_project_id';

export type CharactersEntryDecision =
  | { type: 'redirect'; projectId: number }
  | { type: 'pick' }
  | { type: 'empty' };

export function readLastProjectId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function rememberLastProjectId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    localStorage.setItem(LAST_PROJECT_STORAGE_KEY, String(id));
  } catch {
    /* private mode */
  }
}

export function resolveCharactersEntry(
  projects: Array<{ id: number }>,
  lastProjectId: number | null
): CharactersEntryDecision {
  if (projects.length === 0) return { type: 'empty' };
  if (lastProjectId != null && projects.some((project) => project.id === lastProjectId)) {
    return { type: 'redirect', projectId: lastProjectId };
  }
  return { type: 'pick' };
}
