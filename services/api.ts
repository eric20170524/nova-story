import { 
  API_BASE_URL, 
  MOCK_PROJECTS, 
  MOCK_CHARACTERS, 
  MOCK_CHAPTERS, 
  MOCK_WORKFLOWS, 
  MOCK_TIMELINE 
} from '../constants';
import type { ProjectExport } from '../types';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

interface FetchOptions {
  method?: HttpMethod;
  body?: any;
  headers?: Record<string, string>;
}

class ApiService {
  private async request<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const { method = 'GET', body, headers = {} } = options;

    // Retrieve token from storage
    const token = localStorage.getItem('access_token');
    
    const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
    };

    if (token) {
        reqHeaders['Authorization'] = `Bearer ${token}`;
    }

    const config: RequestInit = {
      method,
      headers: reqHeaders,
    };

    if (body) {
      config.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, config);
      
      if (!response.ok) {
        let errDetail = `API Error ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson.detail) {
            errDetail = typeof errJson.detail === 'string' ? errJson.detail : JSON.stringify(errJson.detail);
          }
        } catch (_) {}
        throw new Error(errDetail);
      }
      
      if (response.status === 204) {
        return {} as T;
      }

      return await response.json();
    } catch (error) {
      const isMockMode = (import.meta as any).env?.VITE_USE_MOCK === 'true';
      if (isMockMode) {
        console.warn(`API Request failed for ${endpoint}. Using Mock Data Fallback.`);
        return this.getMockResponse<T>(endpoint, method, body);
      }
      throw error;
    }
  }

  private getMockResponse<T>(endpoint: string, method: HttpMethod, body?: any): Promise<T> {
    return new Promise((resolve) => {
      setTimeout(() => {
        // Projects
        if (endpoint.startsWith('/projects/')) {
           if (method === 'GET' && endpoint === '/projects/') return resolve(MOCK_PROJECTS as any);
           if (method === 'GET' && endpoint.endsWith('/export')) {
             return resolve({
               format: 'novastory-project',
               version: 1,
               exported_at: new Date().toISOString(),
               project: MOCK_PROJECTS[0],
               screenplay: { chapters: MOCK_CHAPTERS },
               character_center: { characters: MOCK_CHARACTERS },
               director: {
                 scenes: MOCK_TIMELINE.timeline,
                 coverage_groups: [],
                 coverage_shots: []
               },
               summary: {
                 chapters: MOCK_CHAPTERS.length,
                 characters: MOCK_CHARACTERS.length,
                 scenes: MOCK_TIMELINE.timeline.length,
                 coverage_groups: 0,
                 coverage_shots: 0
               }
             } as any);
           }
           if (method === 'GET' && endpoint !== '/projects/') return resolve(MOCK_PROJECTS[0] as any);
           if (method === 'POST') return resolve({ ...body, id: Math.floor(Math.random() * 1000), created_at: new Date().toISOString() } as any);
           if (method === 'PUT') return resolve({ ...MOCK_PROJECTS[0], ...body } as any);
           if (method === 'DELETE') return resolve({} as any);
        }

        // Characters
        if (endpoint.includes('/characters/')) {
          if (method === 'GET') return resolve(MOCK_CHARACTERS as any);
          if (method === 'POST') return resolve({ ...body, id: Math.floor(Math.random() * 1000) } as any);
          if (method === 'PUT') return resolve({ ...body } as any);
          if (method === 'DELETE') return resolve({} as any);
        }
        
        // Chapters
        if (endpoint.includes('/chapters/')) {
          if (method === 'GET') return resolve(MOCK_CHAPTERS as any);
          if (method === 'POST') return resolve({ ...body, id: 'mock-uuid-' + Date.now() } as any);
          if (method === 'PATCH') return resolve({ ...body } as any);
          if (method.includes('PUT') && endpoint.includes('move')) return resolve({ status: 'moved' } as any);
        }

        // Workflows
        if (endpoint.startsWith('/workflows/')) {
           return resolve(MOCK_WORKFLOWS as any);
        }
        
        // Timeline
        if (endpoint.includes('/timeline/generate')) {
           return resolve(MOCK_TIMELINE as any);
        }

        // Assets
        if (endpoint.includes('/assets/generate')) {
           return resolve({ task_id: 'mock-task-999', status: 'processing' } as any);
        }

        // Agent
        if (endpoint.includes('/agent/draft')) {
           return resolve({ content: " (AI Generated Mock Content) Suddenly, the door burst open and..." } as any);
        }
        if (endpoint.includes('/agent/analyze')) {
           return resolve({ new_entities: ["Kael", "Viper"], updates: ["A tense meeting occurred."] } as any);
        }
        
        // Assistant
        if (endpoint.includes('/assistant/chat')) {
           return resolve({ 
             thought: "Processing mock request...", 
             response: "I'm a mock agent. Backend might be unreachable.",
             action: null
           } as any);
        }

        resolve({} as T);
      }, 600); // Simulate network delay
    });
  }

  // Projects
  getProjects = () => this.request<any[]>('/projects/');
  createProject = (data: any) => this.request<any>('/projects/', { method: 'POST', body: data });
  duplicateProject = (id: number, title?: string) => this.request<any>(`/projects/${id}/duplicate`, {
    method: 'POST',
    body: title ? { title } : {}
  });
  getProject = (id: number) => this.request<any>(`/projects/${id}`);
  exportProject = (id: number) => this.request<ProjectExport>(`/projects/${id}/export`);
  updateProject = (id: number, data: any) => this.request<any>(`/projects/${id}`, { method: 'PUT', body: data });
  deleteProject = (id: number) => this.request(`/projects/${id}`, { method: 'DELETE' });
  importProject = (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    
    // Get Token for direct fetch
    const token = localStorage.getItem('access_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    return fetch(`${API_BASE_URL}/projects/import`, {
        method: 'POST',
        headers: headers,
        body: formData,
    }).then(async (response) => {
        if (!response.ok) {
            let detail = `API Error ${response.status}`;
            try {
                const payload = await response.json();
                if (typeof payload?.detail === 'string') detail = payload.detail;
            } catch (_) {}
            throw new Error(detail);
        }
        return await response.json();
    });
  };

  // Characters
  getCharacters = (projectId: number) => this.request<any[]>(`/characters/?project_id=${projectId}`);
  createCharacter = (data: any) => this.request<any>('/characters/', { method: 'POST', body: data });
  updateCharacter = (id: number, data: any) => this.request<any>(`/characters/${id}`, { method: 'PUT', body: data });
  deleteCharacter = (id: number) => this.request(`/characters/${id}`, { method: 'DELETE' });
  extractCharacters = (chapterId: string) => this.request<any[]>('/characters/extract', { method: 'POST', body: { chapter_id: chapterId } });
  buildCharacterPrompt = (
    characterId: number, 
    modelType: string, 
    genType: string, 
    customDesc?: string,
    useRefPortrait?: boolean,
    refImageUrl?: string
  ) => 
    this.request<{ prompt: string; negative_prompt: string; model_type: string; gen_type: string; ref_image_url?: string }>(
      `/characters/${characterId}/build-prompt`, 
      { 
        method: 'POST', 
        body: { 
          model_type: modelType, 
          gen_type: genType, 
          custom_description: customDesc,
          use_ref_portrait: useRefPortrait ?? true,
          ref_image_url: refImageUrl
        } 
      }
    );
  cropCharacterFace = (characterId: number) => this.request<any>(`/characters/${characterId}/crop-face`, { method: 'POST' });
  trainCharacterLora = (characterId: number) => this.request<any>(`/characters/${characterId}/train-lora`, { method: 'POST' });

  uploadCharacterAsset = async (characterId: number, assetType: 'avatar' | 'turnaround' | 'face', file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('asset_type', assetType);

    const token = localStorage.getItem('access_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${API_BASE_URL}/characters/${characterId}/upload-asset`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    return await response.json();
  };

  uploadCharacterImage = async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);

    const token = localStorage.getItem('access_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${API_BASE_URL}/characters/upload-image`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    return await response.json();
  };

  // Chapters
  createChapter = (data: any) => this.request<any>('/chapters/', { method: 'POST', body: data });
  updateChapter = (id: string, data: any) => this.request<any>(`/chapters/${id}`, { method: 'PATCH', body: data });
  deleteChapter = (id: string) => this.request(`/chapters/${id}`, { method: 'DELETE' });
  moveChapter = (id: string, newIndex: number) => this.request<any>(`/chapters/${id}/move`, { method: 'PUT', body: { new_index: newIndex } });
  getChapters = (projectId: number) => this.request<any[]>(`/chapters/?project_id=${projectId}`);

  // Agent / AI
  draftText = (context: string, prompt: string) => this.request<{ content: string }>('/agent/draft', { 
    method: 'POST', 
    body: { 
      context_text: context, 
      instructions: prompt 
    } 
  });
  analyzeText = (text: string) => this.request<any>('/agent/analyze', { method: 'POST', body: { content: text } });
  generateStoryboardGrid = (storyText: string) => this.request<{ prompt: string }>('/agent/storyboard-grid', { method: 'POST', body: { story_text: storyText } });
  
  // Agentic OS
  chatWithAgent = (message: string, context: any, history: any[]) => 
    this.request<any>('/assistant/chat', { method: 'POST', body: { message, context, history } });

  // Timeline & Director
  getTimeline = (chapterId: string) => this.request<any>(`/timeline/${chapterId}`);
  generateTimeline = (chapterId: string, mode: string = 'narrative') => this.request<any>('/timeline/generate', { method: 'POST', body: { chapter_id: chapterId, mode } });
  updateScene = (sceneId: number | string, data: any) => this.request<any>(`/timeline/scene/${sceneId}`, { method: 'PUT', body: data });
  
  // Single-Scene 9-Shot Coverage
  generateSceneCoverage = (sceneId: number | string) => this.request<any>(`/scenes/${sceneId}/coverage`, { method: 'POST' });
  getSceneCoverage = (sceneId: number | string) => this.request<any[]>(`/scenes/${sceneId}/coverage`);
  applyCoverageShot = (shotId: number) => this.request<any>(`/scenes/coverage/${shotId}/apply`, { method: 'POST' });
  promoteCoverageShot = (shotId: number, position: 'before' | 'after' | 'replace' = 'after') => this.request<any>(`/scenes/coverage/${shotId}/promote`, { method: 'POST', body: { position } });
  
  // Workflows
  getWorkflows = () => this.request<any[]>('/workflows/');
  getWorkflowFiles = () => this.request<string[]>('/workflows/files');
  createWorkflow = (data: any) => this.request<any>('/workflows/', { method: 'POST', body: data });
  updateWorkflow = (id: number, data: any) => this.request<any>(`/workflows/${id}`, { method: 'PUT', body: data });

    generateAsset = async (workflowData: any, sceneId: number | string) => {
    // Inject generation_params into the outer payload if they exist in workflowData
    const payload: any = {
        workflow: workflowData,
        scene_id: sceneId,
        mode: workflowData.mode || 'standard'
    };
    if (workflowData.generation_params) {
        payload.generation_params = workflowData.generation_params;
    }

    // Get Token for direct fetch
    const token = localStorage.getItem('access_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_BASE_URL}/assets/generate`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = `Failed to start generation (${res.status})`;
      try {
        const errorPayload = await res.json();
        detail = errorPayload?.detail || errorPayload?.message || detail;
      } catch (_) {}
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return res.json();
  };

  cancelAssetGeneration = () => this.request<any>('/assets/cancel', { method: 'POST' });

  generateComic = async (chapterId: string) => {
    // Get Token for direct fetch
    const token = localStorage.getItem('access_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${API_BASE_URL}/comics/${chapterId}/generate`, {
        method: 'POST',
        headers: headers,
    });
    if (!res.ok) throw new Error('Failed to generate comic');
    return res.json();
  };

  renderVideo = async (timeline: any[], projectId: number): Promise<{ video_url: string }> => {
    // Mock implementation for demo
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve({ video_url: "https://www.w3schools.com/html/mov_bbb.mp4" });
        }, 1500);
    });
  };

  // Settings
  getSettings = () => this.request<any>('/settings/');
  updateSettings = (settings: any) => this.request<any>('/settings/', { method: 'POST', body: settings });
  getLoras = () => this.request<{ lora_directory: string; exists: boolean; loras: string[] }>('/settings/loras');
  verifyLLMConnection = (config: any) => this.request<any>('/settings/verify-llm', { method: 'POST', body: config });
}

export const api = new ApiService();
