import { normalizeImageModelFamily, type ImageModelFamily } from './image_generation_policy';
import { getProjectImageSettings, parseProjectSettings } from './project_settings';

export interface ComfyWorkflowRow {
  id: number;
  name: string;
  content: string;
}

export interface ComfyWorkflowLookup {
  byId: (id: number) => Promise<ComfyWorkflowRow | null>;
  byName: (name: string) => Promise<ComfyWorkflowRow | null>;
}

export interface ComfyWorkflowSelection {
  row: ComfyWorkflowRow;
  source: 'project' | 'model';
  family: ImageModelFamily;
  notes: string[];
}

const parseWorkflowId = (raw: unknown, label: string): number | null => {
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${label} must be a positive workflow ID`);
  }
  return id;
};

export const inferComfyWorkflowFamily = (row: ComfyWorkflowRow): ImageModelFamily => {
  let graph: Record<string, any>;
  try {
    graph = JSON.parse(row.content);
  } catch {
    throw new Error(`ComfyUI workflow ${row.id} (${row.name}) contains invalid JSON`);
  }
  const nodes = Object.values(graph);
  if (nodes.some((node) => node?.class_type === 'UnetLoaderGGUF')) return 'flux';
  if (nodes.some((node) =>
    (node?.class_type === 'UNETLoader' && /redcraft|krea/i.test(String(node.inputs?.unet_name || '')))
    || (node?.class_type === 'CLIPLoader' && /redcraft|krea/i.test(String(node.inputs?.clip_name || node.inputs?.type || '')))
  )) return 'redcraft_krea2';

  const checkpoint = String(nodes.find((node) => node?.class_type === 'CheckpointLoaderSimple')?.inputs?.ckpt_name || '');
  if (/flux/i.test(checkpoint)) return 'flux';
  if (/redcraft|krea/i.test(checkpoint)) return 'redcraft_krea2';
  if (/sd\s*1\.?5|anything|counterfeit|meina|chillout|sd15/i.test(checkpoint)) return 'sd15';
  return normalizeImageModelFamily(row.name);
};

/** A selected project workflow wins over a generic model-family workflow when compatible. */
export const selectComfyWorkflow = async (
  workflowData: any,
  _runtimeSettings: any,
  lookup: ComfyWorkflowLookup
): Promise<ComfyWorkflowSelection> => {
  const projectSettings = getProjectImageSettings(parseProjectSettings(workflowData?.project_settings));
  const requestedFamily = projectSettings.model;
  const notes: string[] = [];

  const projectId = parseWorkflowId(projectSettings.workflow_id, 'workflow_id');
  if (projectId != null) {
    const row = await lookup.byId(projectId);
    if (!row) throw new Error(`Project ComfyUI workflow ID ${projectId} was not found`);
    const family = inferComfyWorkflowFamily(row);
    if (family !== requestedFamily) {
      throw new Error(`Project workflow ${row.name} uses ${family}, but project model is ${requestedFamily}`);
    }
    return { row, source: 'project', family, notes };
  }
  const preferredName = requestedFamily === 'sd15'
    ? 'sd15_draft_12gb'
    : requestedFamily === 'redcraft_krea2'
      ? 'redcraft_krea2_12gb'
      : 'pony_xl_12gb';
  const preferred = await lookup.byName(preferredName);
  if (preferred) {
    const family = inferComfyWorkflowFamily(preferred);
    if (family !== requestedFamily) {
      throw new Error(`Default workflow ${preferred.name} uses ${family}, but model_type requests ${requestedFamily}`);
    }
    return { row: preferred, source: 'model', family, notes };
  }
  throw new Error(`No ComfyUI workflow is configured for model '${requestedFamily}'`);
};
