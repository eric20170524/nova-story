import type {
  ScriptDocument,
  ScriptStatus,
  SourceFreshnessResult,
  ScriptChangeRow,
  ScriptSourceSnapshot,
} from '../../backend/src/schemas/script';

export interface ScriptData {
  id: number;
  chapterId: string;
  projectId: number;
  revision: number;
  status: ScriptStatus;
  document: ScriptDocument;
  freshness: SourceFreshnessResult;
  sourceSnapshot?: ScriptSourceSnapshot;
  pendingChanges?: ScriptChangeRow[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCharacter {
  id: number;
  name: string;
  role?: string | null;
}
