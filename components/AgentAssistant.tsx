import React from 'react';
import { ProjectAgentPanel } from './agent/ProjectAgentPanel';

/**
 * Backward-compatible wrapper: Director and other pages can keep importing AgentAssistant.
 * Full Agent OS UI lives in ProjectAgentPanel (also mounted globally in ProjectLayout).
 */
interface AgentAssistantProps {
  projectId?: string;
  chapterId?: string;
  onRefresh?: () => void;
}

export const AgentAssistant: React.FC<AgentAssistantProps> = ({
  projectId,
  chapterId,
  onRefresh,
}) => {
  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm p-4">
        No project context
      </div>
    );
  }

  return (
    <ProjectAgentPanel
      projectId={String(projectId)}
      chapterId={chapterId}
      embedded
      onRefresh={onRefresh}
    />
  );
};
