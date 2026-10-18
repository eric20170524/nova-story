import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../services/api';
import { scriptReviewCharacters } from '../../services/scriptEntityReferences';
import { Chapter } from '../../types';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { useProjectAgent } from '../../contexts/ProjectAgentContext';
import type { ScriptDocument } from '../../backend/src/schemas/script';
import type { ProjectCharacter, ScriptData } from './scriptTypes';

export function useScriptDocument() {
  const { id: projectIdStr } = useParams<{ id: string }>();
  const projectId = projectIdStr ? parseInt(projectIdStr, 10) : null;
  const { t } = useLanguage();
  const { showToast } = useToast();
  const { activeChapterId, setActiveChapterId, setActiveScriptContext } = useProjectAgent();
  const activeChapterIdRef = useRef(activeChapterId);
  activeChapterIdRef.current = activeChapterId;

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [characters, setCharacters] = useState<ProjectCharacter[]>([]);

  const [loading, setLoading] = useState(false);
  const [scriptData, setScriptData] = useState<ScriptData | null>(null);
  const [document, setDocument] = useState<ScriptDocument | null>(null);
  const reviewCharacters = useMemo(() => scriptReviewCharacters(document, characters), [document, characters]);
  const [isDirty, setIsDirty] = useState(false);
  const [dirtyBaseRevision, setDirtyBaseRevision] = useState<number | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [refreshingSource, setRefreshingSource] = useState(false);
  const [showConfirmPrompt, setShowConfirmPrompt] = useState(false);

  const selectedChapterRef = useRef<Chapter | null>(null);
  selectedChapterRef.current = selectedChapter;
  const chaptersRef = useRef<Chapter[]>([]);
  chaptersRef.current = chapters;

  const documentRef = useRef<ScriptDocument | null>(null);
  documentRef.current = document;

  const scriptDataRef = useRef<ScriptData | null>(null);
  scriptDataRef.current = scriptData;

  const latestLoadChapterIdRef = useRef<string | null>(null);
  const currentLoadedChapterIdRef = useRef<string | null>(null);

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const dirtyBaseRevisionRef = useRef<number | null>(null);
  dirtyBaseRevisionRef.current = dirtyBaseRevision;

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!projectId) return;

    api.getChapters(projectId)
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          const sorted = data.sort((a, b) => a.index - b.index);
          setChapters(sorted);
          const preferred = activeChapterIdRef.current
            ? sorted.find((chapter) => chapter.id === activeChapterIdRef.current)
            : null;
          setSelectedChapter(preferred || sorted[0] || null);
        }
      })
      .catch((err) => {
        console.error('Failed to load chapters:', err);
      });

    api.getCharacters(projectId)
      .then((data) => {
        if (Array.isArray(data)) {
          setCharacters(data);
        }
      })
      .catch((err) => {
        console.error('Failed to load characters:', err);
      });
  }, [projectId]);

  const loadScriptForChapter = useCallback(async (
    chapterId: string,
    options?: { preserveUnsaved?: boolean; force?: boolean }
  ) => {
    latestLoadChapterIdRef.current = chapterId;
    setLoading(true);
    try {
      const res = await api.getChapterScript(chapterId);
      if (
        selectedChapterRef.current?.id !== chapterId ||
        latestLoadChapterIdRef.current !== chapterId
      ) {
        return;
      }
      const isSameChapter = currentLoadedChapterIdRef.current === chapterId;
      const shouldPreserve =
        (options?.preserveUnsaved ?? false) ||
        (isSameChapter && isDirtyRef.current && !options?.force);

      if (res.exists && res.script) {
        setScriptData(res.script);
        if (!(shouldPreserve && isDirtyRef.current)) {
          setDocument(res.script.document);
          setIsDirty(false);
          setDirtyBaseRevision(res.script.revision);
          currentLoadedChapterIdRef.current = chapterId;
        }
      } else {
        setScriptData(null);
        if (!shouldPreserve) {
          setDocument(null);
          setIsDirty(false);
          setDirtyBaseRevision(null);
          currentLoadedChapterIdRef.current = chapterId;
        }
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === chapterId &&
        latestLoadChapterIdRef.current === chapterId
      ) {
        showToast(err.message || '加载剧本失败', 'error');
      }
    } finally {
      if (
        selectedChapterRef.current?.id === chapterId &&
        latestLoadChapterIdRef.current === chapterId
      ) {
        setLoading(false);
      }
    }
  }, [showToast]);

  useEffect(() => {
    if (selectedChapter) {
      setActiveChapterId(selectedChapter.id);
      const isDifferentChapter = currentLoadedChapterIdRef.current !== selectedChapter.id;
      loadScriptForChapter(selectedChapter.id, { force: isDifferentChapter });
    }
  }, [selectedChapter, loadScriptForChapter, setActiveChapterId]);

  useEffect(() => {
    if (!document) {
      setSelectedSceneId(null);
      return;
    }
    setSelectedSceneId((prev) =>
      prev && document.scenes.some((scene) => scene.id === prev)
        ? prev
        : document.scenes[0]?.id ?? null
    );
  }, [document]);

  useEffect(() => {
    setActiveScriptContext(scriptData?.id ?? null, selectedSceneId);
  }, [scriptData?.id, selectedSceneId, setActiveScriptContext]);

  useEffect(() => () => setActiveScriptContext(null, null), [setActiveScriptContext]);

  useEffect(() => {
    const onAgentDataChanged = (event: Event) => {
      const chapterId = (event as CustomEvent<{ chapterId?: string | null }>).detail?.chapterId;
      if (
        chapterId &&
        selectedChapterRef.current &&
        chapterId !== selectedChapterRef.current.id
      ) {
        return;
      }
      if (selectedChapterRef.current) {
        loadScriptForChapter(selectedChapterRef.current.id, { preserveUnsaved: true });
      }
    };
    window.addEventListener('novastory-agent-data-changed', onAgentDataChanged);
    return () => window.removeEventListener('novastory-agent-data-changed', onAgentDataChanged);
  }, [loadScriptForChapter]);

  useEffect(() => {
    const onFinished = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; chapterId?: string }>).detail;
      if (!detail?.chapterId || String(detail.projectId) !== String(projectIdStr)) return;
      if (selectedChapterRef.current?.id !== detail.chapterId) return;
      void loadScriptForChapter(detail.chapterId, { preserveUnsaved: true });
    };
    const onOpenChapter = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; chapterId?: string }>).detail;
      if (!detail?.chapterId || String(detail.projectId) !== String(projectIdStr)) return;
      const chapter = chaptersRef.current.find((item) => item.id === detail.chapterId);
      if (!chapter || chapter.id === selectedChapterRef.current?.id) return;
      if (isDirtyRef.current) {
        const proceed = window.confirm(t('script_editor.unsaved_warning'));
        if (!proceed) return;
      }
      setSelectedChapter(chapter);
    };
    window.addEventListener('novastory-script-candidate-finished', onFinished);
    window.addEventListener('novastory-script-open-chapter', onOpenChapter);
    return () => {
      window.removeEventListener('novastory-script-candidate-finished', onFinished);
      window.removeEventListener('novastory-script-open-chapter', onOpenChapter);
    };
  }, [loadScriptForChapter, projectIdStr, t]);

  const handleSelectChapter = (chapter: Chapter) => {
    if (chapter.id === selectedChapter?.id) return;
    if (isDirty) {
      const proceed = window.confirm(t('script_editor.unsaved_warning'));
      if (!proceed) return;
    }
    setSelectedChapter(chapter);
  };

  const handleCreateScript = async () => {
    if (!selectedChapter) return;
    const targetChapterId = selectedChapter.id;
    setLoading(true);
    try {
      const res = await api.createChapterScript(targetChapterId, `${selectedChapter.title} 短剧剧本`);
      if (selectedChapterRef.current?.id !== targetChapterId) return;
      if (res.script) {
        setScriptData(res.script);
        setDocument(res.script.document);
        setIsDirty(false);
        setDirtyBaseRevision(res.script.revision);
        showToast('已初始化空白剧本', 'success');
      }
    } catch (err: any) {
      if (selectedChapterRef.current?.id === targetChapterId) {
        showToast(err.message || '初始化剧本失败', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const updateDoc = (updater: (prev: ScriptDocument) => ScriptDocument) => {
    setDocument((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      setIsDirty(true);
      return next;
    });
    setDirtyBaseRevision((prev) => (prev !== null ? prev : (scriptDataRef.current?.revision ?? null)));
  };

  const handleSave = async () => {
    if (!scriptData || !document || !selectedChapter) return;
    const saveChapterId = selectedChapter.id;
    const saveScriptId = scriptData.id;
    const saveRevision = dirtyBaseRevisionRef.current ?? scriptData.revision;
    const docSnapshot = document;

    setSaving(true);
    try {
      const res = await api.saveManualScript(saveScriptId, docSnapshot, saveRevision);
      if (
        selectedChapterRef.current?.id !== saveChapterId ||
        scriptDataRef.current?.id !== saveScriptId
      ) {
        return;
      }
      if (res.script) {
        setScriptData(res.script);
        if (documentRef.current === docSnapshot) {
          setDocument(res.script.document);
          setIsDirty(false);
          setDirtyBaseRevision(res.script.revision);
          showToast(t('script_editor.saved_success'), 'success');
        } else {
          setDirtyBaseRevision(res.script.revision);
          showToast('已保存先前修改，当前存在新输入未保存', 'success');
        }
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id !== saveChapterId ||
        scriptDataRef.current?.id !== saveScriptId
      ) {
        return;
      }
      if (err.message?.includes('Revision conflict')) {
        showToast(t('script_editor.conflict_warning'), 'error');
      } else {
        showToast(err.message || '保存失败', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const executeConfirm = async (forceSourceRefresh: boolean) => {
    if (!scriptData || !selectedChapter) return;
    const targetChapterId = selectedChapter.id;
    const targetScriptId = scriptData.id;

    setConfirming(true);
    try {
      const res = await api.confirmScript(
        targetScriptId,
        scriptData.revision,
        forceSourceRefresh
      );
      if (
        selectedChapterRef.current?.id !== targetChapterId ||
        scriptDataRef.current?.id !== targetScriptId
      ) {
        return;
      }
      if (res.script) {
        setScriptData(res.script);
        setDocument(res.script.document);
        setIsDirty(false);
        setDirtyBaseRevision(res.script.revision);
        setShowConfirmPrompt(false);
        showToast(t('script_editor.confirmed_success'), 'success');
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '确认剧本失败', 'error');
      }
    } finally {
      setConfirming(false);
    }
  };

  const handleConfirmClick = () => {
    if (isDirty) {
      showToast('请先保存当前修改再确认定稿', 'warning');
      return;
    }
    if (scriptData?.freshness?.sourceChanged) {
      setShowConfirmPrompt(true);
    } else {
      executeConfirm(false);
    }
  };

  const handleRestore = async () => {
    if (!scriptData || !selectedChapter) return;
    const targetChapterId = selectedChapter.id;
    const targetScriptId = scriptData.id;
    const confirmRestore = window.confirm('确定要恢复到上一个保存版本吗？当前版本将被重放并生成新版本。');
    if (!confirmRestore) return;

    setRestoring(true);
    try {
      const res = await api.restoreScript(targetScriptId, scriptData.revision);
      if (
        selectedChapterRef.current?.id !== targetChapterId ||
        scriptDataRef.current?.id !== targetScriptId
      ) {
        return;
      }
      if (res.script) {
        setScriptData(res.script);
        setDocument(res.script.document);
        setIsDirty(false);
        setDirtyBaseRevision(res.script.revision);
        showToast(t('script_editor.restored_success'), 'success');
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '恢复版本失败', 'error');
      }
    } finally {
      setRestoring(false);
    }
  };

  const handleRefreshSource = async () => {
    if (!scriptData || !selectedChapter) return;
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setRefreshingSource(true);
    try {
      const res = await api.refreshScriptSource(targetScriptId, scriptData.revision);
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        const previousJson = JSON.stringify(scriptData.document);
        const serverJson = JSON.stringify(res.script.document);
        setScriptData(res.script);
        if (serverJson === previousJson) {
          setDirtyBaseRevision(res.script.revision);
        } else if (!isDirtyRef.current) {
          setDocument(res.script.document);
          setIsDirty(false);
          setDirtyBaseRevision(res.script.revision);
        }
        showToast('已成功同步小说最新来源快照', 'success');
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '更新来源快照失败', 'error');
      }
    } finally {
      setRefreshingSource(false);
    }
  };

  return {
    projectIdStr,
    chapters,
    selectedChapter,
    characters,
    loading,
    scriptData,
    setScriptData,
    document,
    setDocument,
    isDirty,
    setIsDirty,
    setDirtyBaseRevision,
    reviewCharacters,
    selectedSceneId,
    setSelectedSceneId,
    saving,
    confirming,
    restoring,
    refreshingSource,
    showConfirmPrompt,
    setShowConfirmPrompt,
    selectedChapterRef,
    scriptDataRef,
    isDirtyRef,
    loadScriptForChapter,
    handleSelectChapter,
    handleCreateScript,
    updateDoc,
    handleSave,
    executeConfirm,
    handleConfirmClick,
    handleRestore,
    handleRefreshSource,
  };
}
