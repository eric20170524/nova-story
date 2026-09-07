import fs from 'node:fs';
import path from 'node:path';
import { getVideoWorkflowsDirectory } from '../../core/paths';
import {
  DEFAULT_VIDEO_WORKFLOW_ID,
  VideoSpec,
  VideoWorkflowId
} from '../../schemas/video';

export interface WorkflowManifestSlot {
  node: string;
  input: string;
}

export interface WorkflowManifest {
  schema_version: number;
  workflow_id: string;
  name: string;
  description?: string;
  stability?: 'experimental' | 'candidate' | 'stable' | string;
  workflow_family?: string;
  upstream_reference?: string;
  slots: {
    positive_prompt?: WorkflowManifestSlot;
    negative_prompt?: WorkflowManifestSlot;
    first_frame?: WorkflowManifestSlot;
    last_frame?: WorkflowManifestSlot;
    character_refs?: WorkflowManifestSlot[];
    video_refs?: WorkflowManifestSlot[];
    width?: WorkflowManifestSlot;
    height?: WorkflowManifestSlot;
    frames?: WorkflowManifestSlot;
    fps?: WorkflowManifestSlot;
    steps?: WorkflowManifestSlot;
    seed?: WorkflowManifestSlot;
    output_prefix?: WorkflowManifestSlot;
  };
  default_params?: Record<string, any>;
  required_models?: string[];
  required_custom_nodes?: Array<{
    name: string;
    nodes?: string[];
    min_version?: string;
  }>;
}

export interface CompileWorkflowInputs {
  workflowId?: VideoWorkflowId;
  spec: VideoSpec;
  stagedFiles: {
    firstFrameFilename: string;
    lastFrameFilename?: string;
    characterRefFilenames?: string[];
    motionRefFilename?: string;
  };
  seed?: number;
  outputPrefix?: string;
}

export class VideoWorkflowCompiler {
  static loadWorkflowBundle(workflowId: VideoWorkflowId = DEFAULT_VIDEO_WORKFLOW_ID): {
    manifest: WorkflowManifest;
    workflow: Record<string, any>;
  } {
    const dir = getVideoWorkflowsDirectory();
    const manifestPath = path.join(dir, `${workflowId}.manifest.json`);
    const workflowPath = path.join(dir, `${workflowId}.api.json`);

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Video workflow manifest not found: ${manifestPath}`);
    }
    if (!fs.existsSync(workflowPath)) {
      throw new Error(`Video workflow API template not found: ${workflowPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as WorkflowManifest;
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8')) as Record<string, any>;
    return { manifest, workflow };
  }

  static validateSlot(workflow: Record<string, any>, slot: WorkflowManifestSlot, slotName: string) {
    const targetNode = workflow[slot.node];
    if (!targetNode) {
      throw new Error(`Workflow node '${slot.node}' declared in slot '${slotName}' does not exist in workflow graph.`);
    }
    if (!targetNode.inputs || typeof targetNode.inputs !== 'object') {
      throw new Error(`Workflow node '${slot.node}' inputs object missing for slot '${slotName}'.`);
    }
  }

  static compile(inputs: CompileWorkflowInputs): {
    workflow: Record<string, any>;
    manifest: WorkflowManifest;
    appliedParams: Record<string, any>;
  } {
    const workflowId: VideoWorkflowId = inputs.workflowId || inputs.spec.workflow_id || DEFAULT_VIDEO_WORKFLOW_ID;
    const { manifest, workflow: template } = this.loadWorkflowBundle(workflowId);

    const workflow = JSON.parse(JSON.stringify(template));
    const slots = manifest.slots;
    const { spec, stagedFiles } = inputs;
    const contract = spec.output_contract;

    if (slots.positive_prompt) this.validateSlot(workflow, slots.positive_prompt, 'positive_prompt');
    if (slots.negative_prompt) this.validateSlot(workflow, slots.negative_prompt, 'negative_prompt');
    if (slots.first_frame) this.validateSlot(workflow, slots.first_frame, 'first_frame');
    if (slots.last_frame) this.validateSlot(workflow, slots.last_frame, 'last_frame');
    if (slots.width) this.validateSlot(workflow, slots.width, 'width');
    if (slots.height) this.validateSlot(workflow, slots.height, 'height');
    if (slots.frames) this.validateSlot(workflow, slots.frames, 'frames');
    if (slots.fps) this.validateSlot(workflow, slots.fps, 'fps');
    if (slots.steps) this.validateSlot(workflow, slots.steps, 'steps');
    if (slots.seed) this.validateSlot(workflow, slots.seed, 'seed');
    if (slots.output_prefix) this.validateSlot(workflow, slots.output_prefix, 'output_prefix');

    if (slots.positive_prompt) {
      workflow[slots.positive_prompt.node].inputs[slots.positive_prompt.input] = spec.positive_prompt;
    }
    if (slots.negative_prompt) {
      workflow[slots.negative_prompt.node].inputs[slots.negative_prompt.input] = spec.negative_prompt;
    }
    if (slots.first_frame && stagedFiles.firstFrameFilename) {
      workflow[slots.first_frame.node].inputs[slots.first_frame.input] = stagedFiles.firstFrameFilename;
    }

    if (slots.last_frame) {
      const lastFrame = stagedFiles.lastFrameFilename || stagedFiles.firstFrameFilename;
      workflow[slots.last_frame.node].inputs[slots.last_frame.input] = lastFrame;
    }

    if (slots.character_refs && Array.isArray(slots.character_refs)) {
      const refs = stagedFiles.characterRefFilenames || [];
      slots.character_refs.forEach((slot, idx) => {
        if (workflow[slot.node]?.inputs) {
          const file = refs[idx] || refs[0] || stagedFiles.firstFrameFilename;
          workflow[slot.node].inputs[slot.input] = file;
        }
      });
    }

    if (slots.video_refs && Array.isArray(slots.video_refs) && slots.video_refs.length > 0) {
      const slot = slots.video_refs[0];
      if (slot && workflow[slot.node]?.inputs && stagedFiles.motionRefFilename) {
        workflow[slot.node].inputs[slot.input] = stagedFiles.motionRefFilename;
      }
    }

    if (slots.width) workflow[slots.width.node].inputs[slots.width.input] = contract.width;
    if (slots.height) workflow[slots.height.node].inputs[slots.height.input] = contract.height;
    if (slots.frames) workflow[slots.frames.node].inputs[slots.frames.input] = contract.frames;
    if (slots.fps) workflow[slots.fps.node].inputs[slots.fps.input] = contract.fps;

    // Preserve the original experimental tuning while the official candidates use
    // their Golden baseline step count. This keeps strategy selection from silently
    // changing established output behavior.
    let steps: number;
    if (workflowId === DEFAULT_VIDEO_WORKFLOW_ID) {
      steps = spec.preset === 'preview_480p_5s' ? 6 : 10;
    } else {
      const manifestSteps = Number(manifest.default_params?.steps);
      steps = Number.isFinite(manifestSteps) && manifestSteps > 0 ? manifestSteps : 20;
    }
    if (slots.steps) workflow[slots.steps.node].inputs[slots.steps.input] = steps;

    const seed = inputs.seed != null ? inputs.seed : Math.floor(Math.random() * 100000000);
    if (slots.seed) workflow[slots.seed.node].inputs[slots.seed.input] = seed;

    const prefix = inputs.outputPrefix || `NovaH3_${Date.now()}`;
    if (slots.output_prefix) workflow[slots.output_prefix.node].inputs[slots.output_prefix.input] = prefix;

    return {
      workflow,
      manifest,
      appliedParams: {
        workflow_id: workflowId,
        workflow_family: manifest.workflow_family || 'unknown',
        stability: manifest.stability || 'unknown',
        width: contract.width,
        height: contract.height,
        frames: contract.frames,
        delivery_frames: 120,
        fps: contract.fps,
        steps,
        seed,
        prefix
      }
    };
  }

  static validateAgainstComfyObjectInfo(
    objectInfo: Record<string, any> | null,
    manifest: WorkflowManifest,
    workflow: Record<string, any>
  ): { valid: boolean; missingNodes: string[]; missingSlots: string[]; missingModels: string[] } {
    const missingNodes: string[] = [];
    const missingSlots: string[] = [];
    const missingModels: string[] = [];

    if (!objectInfo) {
      return {
        valid: false,
        missingNodes: ['ComfyUI object_info unavailable'],
        missingSlots: [],
        missingModels: manifest.required_models || []
      };
    }

    for (const nodeData of Object.values(workflow)) {
      const classType = (nodeData as any)?.class_type;
      if (classType && !objectInfo[classType] && !missingNodes.includes(classType)) {
        missingNodes.push(classType);
      }
    }

    for (const [slotName, slotValue] of Object.entries(manifest.slots)) {
      if (!slotValue) continue;
      const slotList = Array.isArray(slotValue) ? slotValue : [slotValue];
      for (const s of slotList) {
        if (!workflow[s.node]) {
          missingSlots.push(`Slot '${slotName}' references missing node '${s.node}'`);
        } else if (!workflow[s.node].inputs || workflow[s.node].inputs[s.input] === undefined) {
          missingSlots.push(`Slot '${slotName}' references missing input '${s.input}' on node '${s.node}'`);
        }
      }
    }

    const objectInfoText = JSON.stringify(objectInfo);
    for (const modelName of manifest.required_models || []) {
      if (!objectInfoText.includes(modelName)) missingModels.push(modelName);
    }

    return {
      valid: missingNodes.length === 0 && missingSlots.length === 0 && missingModels.length === 0,
      missingNodes,
      missingSlots,
      missingModels
    };
  }
}
