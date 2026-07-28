export type AssetTaskStatus = 'processing' | 'completed' | 'failed';

export interface AssetTaskState {
  task_id: string;
  scene_id: number;
  status: AssetTaskStatus;
  image_url?: string;
  error?: string;
  updated_at: string;
}

const tasks = new Map<string, AssetTaskState>();

const save = (state: AssetTaskState) => {
  tasks.set(state.task_id, state);
  return state;
};

export const AssetTaskStore = {
  processing(taskId: string, sceneId: number) {
    return save({
      task_id: taskId,
      scene_id: sceneId,
      status: 'processing',
      updated_at: new Date().toISOString()
    });
  },

  completed(taskId: string, sceneId: number, imageUrl: string) {
    return save({
      task_id: taskId,
      scene_id: sceneId,
      status: 'completed',
      image_url: imageUrl,
      updated_at: new Date().toISOString()
    });
  },

  failed(taskId: string, sceneId: number, error: string) {
    return save({
      task_id: taskId,
      scene_id: sceneId,
      status: 'failed',
      error,
      updated_at: new Date().toISOString()
    });
  },

  get(taskId: string) {
    return tasks.get(taskId);
  }
};
