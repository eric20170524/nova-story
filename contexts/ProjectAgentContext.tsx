import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';

type ProjectAgentContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Bump when agent mutates project data so pages can reload */
  refreshToken: number;
  notifyDataChanged: () => void;
  activeChapterId: string | null;
  setActiveChapterId: (id: string | null) => void;
};

const ProjectAgentContext = createContext<ProjectAgentContextValue | null>(
  null
);

export const ProjectAgentProvider: React.FC<{
  children: React.ReactNode;
  projectId: string;
}> = ({ children, projectId }) => {
  const [open, setOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`director_project_${projectId}_chapter`);
    } catch {
      return null;
    }
  });

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const notifyDataChanged = useCallback(() => {
    setRefreshToken((n) => n + 1);
    window.dispatchEvent(
      new CustomEvent('novastory-agent-data-changed', {
        detail: { projectId },
      })
    );
  }, [projectId]);

  const value = useMemo(
    () => ({
      open,
      setOpen,
      toggle,
      refreshToken,
      notifyDataChanged,
      activeChapterId,
      setActiveChapterId: (id: string | null) => {
        setActiveChapterId(id);
        if (id) {
          try {
            localStorage.setItem(`director_project_${projectId}_chapter`, id);
          } catch {
            /* ignore */
          }
        }
      },
    }),
    [
      open,
      toggle,
      refreshToken,
      notifyDataChanged,
      activeChapterId,
      projectId,
    ]
  );

  return (
    <ProjectAgentContext.Provider value={value}>
      {children}
    </ProjectAgentContext.Provider>
  );
};

export const useProjectAgent = () => {
  const ctx = useContext(ProjectAgentContext);
  if (!ctx) {
    throw new Error('useProjectAgent must be used within ProjectAgentProvider');
  }
  return ctx;
};

/** Optional hook when outside project layout */
export const useProjectAgentOptional = () => useContext(ProjectAgentContext);
