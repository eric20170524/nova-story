import { ApiError } from './api_error';

/** Story planning has no mock payload. Reject before any timer so the caller can settle. */
export function unsupportedMockResponse<T>(endpoint: string): Promise<T> | null {
  if (!endpoint.includes('/story-plan')) return null;
  return Promise.reject(new ApiError('构思与规划在模拟数据模式下不可用', 501, 'MOCK_UNSUPPORTED'));
}
