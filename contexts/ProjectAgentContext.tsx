import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';

type ApplyHandler = (
  content: string,
  opts?: { alreadyPersisted?: boolean }
) => void;

type ProjectAgentContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Bump when agent mutates project data so pages can reload */
  refreshToken: number;
  notifyDataChanged: () => void;
  activeChapterId: string | null;
  setActiveChapterId: (id: string | null) => void;
  sendPrompt: (prompt: string) => void;
  pendingPrompt: string | null;
  clearPendingPrompt: () => void;
  registerApplyHandler: (handler: ApplyHandler | null) => void;
  /** Push rewritten chapter body into the active story editor (if registered). */
  applyContent: ApplyHandler;
};

const ProjectAgentContext = createContext<ProjectAgentContextValue | null>(
  null
);

export const ProjectAgentProvider: React.FC<{
  children: React.ReactNode;
  projectId: string;
}> = ({ children, projectId }) => {
  const [open, setOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  // Ref (not state): registering a handler must not re-render Provider / change context identity
  const applyHandlerRef = useRef<ApplyHandler | null>(null);
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

  const sendPrompt = useCallback((prompt: string) => {
    setOpen(true);
    setPendingPrompt(prompt);
  }, []);

  const clearPendingPrompt = useCallback(() => {
    setPendingPrompt(null);
  }, []);

  const registerApplyHandler = useCallback((handler: ApplyHandler | null) => {
    applyHandlerRef.current = handler;
  }, []);

  const applyContent = useCallback<ApplyHandler>((content, opts) => {
    applyHandlerRef.current?.(content, opts);
  }, []);

  const setActiveChapterIdStable = useCallback(
    (id: string | null) => {
      setActiveChapterId(id);
      if (id) {
        try {
          localStorage.setItem(`director_project_${projectId}_chapter`, id);
        } catch {
          /* ignore */
        }
      }
    },
    [projectId]
  );

  const value = useMemo(
    () => ({
      open,
      setOpen,
      toggle,
      refreshToken,
      notifyDataChanged,
      activeChapterId,
      setActiveChapterId: setActiveChapterIdStable,
      sendPrompt,
      pendingPrompt,
      clearPendingPrompt,
      registerApplyHandler,
      applyContent,
    }),
    [
      open,
      toggle,
      refreshToken,
      notifyDataChanged,
      activeChapterId,
      setActiveChapterIdStable,
      sendPrompt,
      pendingPrompt,
      clearPendingPrompt,
      registerApplyHandler,
      applyContent,
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
