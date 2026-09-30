import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import {
  Save,
  CheckCircle2,
  RotateCcw,
  Download,
  Copy,
  Plus,
  Trash2,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  BookOpen,
  Clapperboard,
  Layers,
  MapPin,
  Package,
  MessageSquare,
  Volume2,
  Mic,
  Activity,
  X,
  Check,
  Sparkles,
  GitPullRequest,
  Eye,
  EyeOff,
  Edit3,
  FileText,
} from 'lucide-react';
import { api } from '../services/api';
import { Chapter } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { useProjectAgent } from '../contexts/ProjectAgentContext';
import type {
  ScriptDocument,
  ScriptScene,
  ScriptBlock,
  ScriptStatus,
  SourceFreshnessResult,
  ScriptChangeRow,
} from '../backend/src/schemas/script';

interface ScriptData {
  id: number;
  chapterId: string;
  projectId: number;
  revision: number;
  status: ScriptStatus;
  document: ScriptDocument;
  freshness: SourceFreshnessResult;
  pendingChanges?: ScriptChangeRow[];
  createdAt: string;
  updatedAt: string;
}

interface ProjectCharacter {
  id: number;
  name: string;
  role?: string | null;
}

export const ScriptEditor: React.FC = () => {
  const { id: projectIdStr } = useParams<{ id: string }>();
  const projectId = projectIdStr ? parseInt(projectIdStr, 10) : null;
  const { t } = useLanguage();
  const { showToast } = useToast();
  const { activeChapterId, setActiveChapterId, setActiveScriptContext } = useProjectAgent();
  const activeChapterIdRef = useRef(activeChapterId);
  activeChapterIdRef.current = activeChapterId;

  // Project state
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [characters, setCharacters] = useState<ProjectCharacter[]>([]);

  // Script state
  const [loading, setLoading] = useState(false);
  const [scriptData, setScriptData] = useState<ScriptData | null>(null);
  const [document, setDocument] = useState<ScriptDocument | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [dirtyBaseRevision, setDirtyBaseRevision] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'scenes' | 'outline' | 'locations_props'>('scenes');
  const [showProsePanel, setShowProsePanel] = useState(true);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);

  // Saving / Actions state
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // AI Generation & Candidates state
  const [generatingOutline, setGeneratingOutline] = useState(false);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [generatingStoryboard, setGeneratingStoryboard] = useState(false);
  const [timelineSceneCount, setTimelineSceneCount] = useState<number | null>(null);
  const [rewritingSceneId, setRewritingSceneId] = useState<string | null>(null);
  const [applyingChangeId, setApplyingChangeId] = useState<string | null>(null);
  const [discardingChangeId, setDiscardingChangeId] = useState<string | null>(null);
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null);
  const [editingCandidateJson, setEditingCandidateJson] = useState<string>('');
  const [isSavingCandidate, setIsSavingCandidate] = useState<boolean>(false);
  const [refreshingSource, setRefreshingSource] = useState<boolean>(false);

  // Modals state
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [markdownContent, setMarkdownContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [showConfirmPrompt, setShowConfirmPrompt] = useState(false);

  // Tracking refs to prevent async race conditions (P1-3)
  const selectedChapterRef = useRef<Chapter | null>(null);
  selectedChapterRef.current = selectedChapter;

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

  // Window unload guard
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

  // Load project chapters and characters
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

  // Load screenplay for selected chapter
  const loadScriptForChapter = useCallback(async (
    chapterId: string,
    options?: { preserveUnsaved?: boolean; force?: boolean }
  ) => {
    latestLoadChapterIdRef.current = chapterId;
    setLoading(true);
    try {
      const res = await api.getChapterScript(chapterId);
      // Stale check: verify current selected chapter is still chapterId and matches latest load request
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
        if (shouldPreserve && isDirtyRef.current) {
          // Keep current dirty document, protect unsaved user edits
        } else {
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
    if (!selectedChapter) {
      setTimelineSceneCount(null);
      return;
    }
    let isCancelled = false;
    api.getTimeline(selectedChapter.id)
      .then((res: any) => {
        if (!isCancelled) {
          const count = Array.isArray(res) ? res.length : (res?.timeline?.length ?? (res?.scenes?.length ?? 0));
          setTimelineSceneCount(count);
        }
      })
      .catch(() => {
        if (!isCancelled) setTimelineSceneCount(null);
      });
    return () => { isCancelled = true; };
  }, [selectedChapter?.id]);

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

  // Safe chapter switch
  const handleSelectChapter = (chapter: Chapter) => {
    if (chapter.id === selectedChapter?.id) return;
    if (isDirty) {
      const proceed = window.confirm(t('script_editor.unsaved_warning'));
      if (!proceed) return;
    }
    setSelectedChapter(chapter);
  };

  // Create initial script
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

  // Modify document helper
  const updateDoc = (updater: (prev: ScriptDocument) => ScriptDocument) => {
    setDocument((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      setIsDirty(true);
      return next;
    });
    setDirtyBaseRevision((prev) => (prev !== null ? prev : (scriptDataRef.current?.revision ?? null)));
  };

  // Save manual edits
  const handleSave = async () => {
    if (!scriptData || !document || !selectedChapter) return;
    const saveChapterId = selectedChapter.id;
    const saveScriptId = scriptData.id;
    const saveRevision = dirtyBaseRevisionRef.current ?? scriptData.revision;
    const docSnapshot = document;

    setSaving(true);
    try {
      const res = await api.saveManualScript(saveScriptId, docSnapshot, saveRevision);
      // Check if user changed chapter or script during in-flight save
      if (
        selectedChapterRef.current?.id !== saveChapterId ||
        scriptDataRef.current?.id !== saveScriptId
      ) {
        return;
      }
      if (res.script) {
        setScriptData(res.script);
        // If document was not edited further while save was in progress, sync and clear dirty
        if (documentRef.current === docSnapshot) {
          setDocument(res.script.document);
          setIsDirty(false);
          setDirtyBaseRevision(res.script.revision);
          showToast(t('script_editor.saved_success'), 'success');
        } else {
          // Newer edits exist; preserve current document and update base revision to the newly saved version
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

  // Confirm script
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

  // Restore previous version
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

  // AI Adaptation & Candidate handlers
  const handleGenerateOutline = async () => {
    if (!scriptData || !selectedChapter) return;
    if (isDirty) {
      showToast('请先保存当前未保存的修改，再生成提纲候选', 'warning');
      return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setGeneratingOutline(true);
    try {
      await api.createScriptCandidate(targetScriptId, {
        kind: 'outline',
        expected_revision: scriptData.revision,
        request_key: `fe_outline_${targetScriptId}_${Date.now()}`,
      });
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast('已生成改编提纲候选，请在下方审核采纳', 'success');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '生成改编提纲失败', 'error');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } finally {
      setGeneratingOutline(false);
    }
  };

  const handleGenerateScript = async () => {
    if (!scriptData || !selectedChapter) return;
    if (isDirty) {
      showToast('请先保存当前未保存的修改，再生成剧本候选', 'warning');
      return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setGeneratingScript(true);
    try {
      await api.createScriptCandidate(targetScriptId, {
        kind: 'script',
        expected_revision: scriptData.revision,
        request_key: `fe_script_${targetScriptId}_${Date.now()}`,
      });
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast('已生成完整分场短剧剧本候选，请在下方审核采纳', 'success');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '生成剧本候选失败', 'error');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } finally {
      setGeneratingScript(false);
    }
  };

  const handleRewriteScene = async (sceneId: string) => {
    if (!scriptData || !selectedChapter) return;
    if (isDirty) {
      showToast('请先保存当前未保存的修改，再改写此分场', 'warning');
      return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setSelectedSceneId(sceneId);
    setRewritingSceneId(sceneId);
    try {
      await api.createScriptCandidate(targetScriptId, {
        kind: 'scene',
        target_scene_id: sceneId,
        expected_revision: scriptData.revision,
        request_key: `fe_scene_${targetScriptId}_${sceneId}_${Date.now()}`,
      });
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(`已生成分场 ${sceneId} 改写候选，请在下方审核采纳`, 'success');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '改写分场失败', 'error');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } finally {
      setRewritingSceneId(null);
    }
  };

  const handleGenerateStoryboard = async () => {
    if (!scriptData || !selectedChapter) return;
    if (scriptData.status !== 'confirmed') {
      showToast('只有已确认（confirmed）的剧本才能生成分镜候选', 'warning');
      return;
    }
    if (scriptData.freshness?.sourceChanged) {
      showToast('剧本来源已过期，请核对更新剧本后再生成分镜候选', 'warning');
      return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setGeneratingStoryboard(true);
    try {
      await api.createStoryboardCandidate(targetScriptId, {
        expected_revision: scriptData.revision,
        request_key: `fe_storyboard_${targetScriptId}_${Date.now()}`,
      });
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast('已生成导演分镜候选，请在待审核候选区查看和提交', 'success');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '生成分镜候选失败', 'error');
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } finally {
      setGeneratingStoryboard(false);
    }
  };

  const handleApplyCandidate = async (candidate: any) => {
    if (!scriptData || !selectedChapter) return;
    if (candidate.kind !== 'storyboard' && isDirty) {
      const proceed = window.confirm('采纳候选将以候选内容更新正式剧本，当前未保存的临时输入将被覆盖。确定继续吗？');
      if (!proceed) return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setApplyingChangeId(candidate.id);
    try {
      if (candidate.kind === 'storyboard') {
        if (timelineSceneCount !== null && timelineSceneCount > 0) {
          showToast(t('script_editor.timeline_not_empty_warning'), 'warning');
          return;
        }
        const res = await api.applyStoryboardCandidate(targetScriptId, candidate.id, {
          expected_revision: scriptData.revision,
          expected_candidate_revision: candidate.candidate_revision,
        });
        if (
          selectedChapterRef.current?.id === targetChapterId &&
          scriptDataRef.current?.id === targetScriptId
        ) {
          showToast(t('script_editor.candidate_submitted_success'), 'success');
          setTimelineSceneCount(res.count);
          await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
        }
        return;
      }

      const res = await api.applyScriptCandidate(targetScriptId, candidate.id, {
        expected_revision: scriptData.revision,
        expected_candidate_revision: candidate.candidate_revision,
      });
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        if (res.script) {
          setScriptData(res.script);
          setDocument(res.script.document);
          setIsDirty(false);
          setDirtyBaseRevision(res.script.revision);
          showToast(t('script_editor.candidate_applied_success'), 'success');
        }
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '采纳候选失败', 'error');
      }
    } finally {
      setApplyingChangeId(null);
    }
  };

  const handleDiscardCandidate = async (candidate: any) => {
    if (!scriptData || !selectedChapter) return;
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setDiscardingChangeId(candidate.id);
    try {
      await api.discardScriptCandidate(targetScriptId, candidate.id);
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(t('script_editor.candidate_discarded_success'), 'info');
        setScriptData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pendingChanges: (prev.pendingChanges || []).filter((c) => c.id !== candidate.id),
          };
        });
        await loadScriptForChapter(targetChapterId, { preserveUnsaved: true });
      }
    } catch (err: any) {
      if (
        selectedChapterRef.current?.id === targetChapterId &&
        scriptDataRef.current?.id === targetScriptId
      ) {
        showToast(err.message || '丢弃候选失败', 'error');
      }
    } finally {
      setDiscardingChangeId(null);
    }
  };

  const handleStartEditCandidate = (cand: any, parsedPayload: any) => {
    setEditingCandidateId(cand.id);
    setEditingCandidateJson(cand.after_json || JSON.stringify(parsedPayload, null, 2));
    setExpandedCandidateId(cand.id);
  };

  const handleSaveCandidateEdit = async (cand: any) => {
    if (!scriptData) return;
    try {
      JSON.parse(editingCandidateJson);
    } catch (e: any) {
      showToast('候选内容必须为合法 JSON: ' + e.message, 'error');
      return;
    }

    setIsSavingCandidate(true);
    try {
      const res = await api.updateScriptCandidate(scriptData.id, cand.id, {
        expected_revision: scriptData.revision,
        expected_candidate_revision: cand.candidate_revision,
        after_json: editingCandidateJson,
      });
      if (res.candidate) {
        setScriptData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            pendingChanges: (prev.pendingChanges || []).map((c) =>
              c.id === cand.id ? res.candidate : c
            ),
          };
        });
        showToast(`候选修改已保存 (版本 v${res.candidate.candidate_revision})`, 'success');
        setEditingCandidateId(null);
      }
    } catch (err: any) {
      showToast(err.message || '保存候选修改失败', 'error');
    } finally {
      setIsSavingCandidate(false);
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

  // Open Markdown export modal
  const handleOpenExport = async () => {
    if (!scriptData) return;
    try {
      const res = await api.exportScriptMarkdown(scriptData.id);
      setMarkdownContent(res.markdown || '');
      setCopied(false);
      setExportModalOpen(true);
    } catch (err: any) {
      showToast(err.message || '生成导出失败', 'error');
    }
  };

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(markdownContent);
    setCopied(true);
    showToast(t('script_editor.copied'), 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadMarkdown = () => {
    const filename = `${document?.title || '短剧剧本'}_v${scriptData?.revision || 1}.md`;
    const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Scene editing helpers
  const handleAddScene = () => {
    const newSceneId = `sc_${Date.now()}`;
    const newScene: ScriptScene = {
      id: newSceneId,
      beatIds: [],
      eventIds: [],
      sourceParagraphIds: [],
      locationId: document?.locations[0]?.id || '',
      interiorExterior: 'interior',
      timeOfDay: '日',
      characterIds: [],
      propIds: [],
      blocks: [
        {
          id: `b_act_${Date.now()}`,
          type: 'action',
          text: '',
        },
      ],
      estimatedDurationSec: 30,
    };
    updateDoc((doc) => ({
      ...doc,
      scenes: [...doc.scenes, newScene],
    }));
  };

  const handleDeleteScene = (sceneIndex: number) => {
    if (!window.confirm(t('script_editor.delete_scene_confirm'))) return;
    updateDoc((doc) => {
      const nextScenes = [...doc.scenes];
      nextScenes.splice(sceneIndex, 1);
      return { ...doc, scenes: nextScenes };
    });
  };

  const handleMoveScene = (index: number, direction: 'up' | 'down') => {
    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const targetIdx = direction === 'up' ? index - 1 : index + 1;
      if (targetIdx < 0 || targetIdx >= scenes.length) return doc;
      const current = scenes[index];
      const target = scenes[targetIdx];
      if (!current || !target) return doc;
      scenes[index] = target;
      scenes[targetIdx] = current;
      return { ...doc, scenes };
    });
  };

  const handleUpdateSceneMeta = (
    sceneIndex: number,
    field: keyof ScriptScene,
    value: any
  ) => {
    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const scene = scenes[sceneIndex];
      if (!scene) return doc;
      scenes[sceneIndex] = { ...scene, [field]: value };
      return { ...doc, scenes };
    });
  };

  const handleToggleSceneCast = (sceneIndex: number, charId: number) => {
    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const scene = scenes[sceneIndex];
      if (!scene) return doc;
      const cast = new Set(scene.characterIds);
      let blocks = scene.blocks;
      if (cast.has(charId)) {
        cast.delete(charId);
        blocks = scene.blocks.flatMap((block) => {
          if (block.type === 'dialogue' && block.characterId === charId) return [];
          if (block.type === 'voiceover' && block.characterId === charId) {
            return [{ ...block, characterId: null }];
          }
          return [block];
        });
      } else {
        cast.add(charId);
      }
      scenes[sceneIndex] = { ...scene, characterIds: Array.from(cast), blocks };
      return { ...doc, scenes };
    });
  };

  // Block editing helpers
  const handleAddBlock = (sceneIndex: number, type: ScriptBlock['type']) => {
    const blockId = `b_${type}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    let newBlock: ScriptBlock;
    if (type === 'action') {
      newBlock = { id: blockId, type: 'action', text: '' };
    } else if (type === 'dialogue') {
      const speakerId = characters[0]?.id;
      if (!speakerId) {
        showToast('请先在角色中心建立角色，再添加对白', 'warning');
        return;
      }
      newBlock = {
        id: blockId,
        type: 'dialogue',
        characterId: speakerId,
        text: '',
        delivery: '',
      };
    } else if (type === 'voiceover') {
      newBlock = { id: blockId, type: 'voiceover', characterId: null, text: '' };
    } else {
      newBlock = { id: blockId, type: 'sound', text: '' };
    }

    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const scene = scenes[sceneIndex];
      if (!scene) return doc;
      const speakerId =
        newBlock.type === 'dialogue' || newBlock.type === 'voiceover'
          ? newBlock.characterId
          : null;
      scenes[sceneIndex] = {
        ...scene,
        characterIds:
          typeof speakerId === 'number' && !scene.characterIds.includes(speakerId)
            ? [...scene.characterIds, speakerId]
            : scene.characterIds,
        blocks: [...scene.blocks, newBlock],
      };
      return { ...doc, scenes };
    });
  };

  const handleUpdateBlock = (
    sceneIndex: number,
    blockIndex: number,
    updatedFields: Partial<ScriptBlock>
  ) => {
    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const scene = scenes[sceneIndex];
      if (!scene) return doc;
      const blocks = [...scene.blocks];
      const block = blocks[blockIndex];
      if (!block) return doc;
      const nextBlock = { ...block, ...updatedFields } as ScriptBlock;
      blocks[blockIndex] = nextBlock;
      const speakerId =
        (nextBlock.type === 'dialogue' || nextBlock.type === 'voiceover') &&
        typeof nextBlock.characterId === 'number'
          ? nextBlock.characterId
          : null;
      scenes[sceneIndex] = {
        ...scene,
        characterIds:
          speakerId !== null && !scene.characterIds.includes(speakerId)
            ? [...scene.characterIds, speakerId]
            : scene.characterIds,
        blocks,
      };
      return { ...doc, scenes };
    });
  };

  const handleDeleteBlock = (sceneIndex: number, blockIndex: number) => {
    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const scene = scenes[sceneIndex];
      if (!scene) return doc;
      const blocks = [...scene.blocks];
      blocks.splice(blockIndex, 1);
      scenes[sceneIndex] = { ...scene, blocks };
      return { ...doc, scenes };
    });
  };

  const handleMoveBlock = (
    sceneIndex: number,
    blockIndex: number,
    direction: 'up' | 'down'
  ) => {
    updateDoc((doc) => {
      const scenes = [...doc.scenes];
      const scene = scenes[sceneIndex];
      if (!scene) return doc;
      const blocks = [...scene.blocks];
      const targetIdx = direction === 'up' ? blockIndex - 1 : blockIndex + 1;
      if (targetIdx < 0 || targetIdx >= blocks.length) return doc;
      const current = blocks[blockIndex];
      const target = blocks[targetIdx];
      if (!current || !target) return doc;
      blocks[blockIndex] = target;
      blocks[targetIdx] = current;
      scenes[sceneIndex] = { ...scene, blocks };
      return { ...doc, scenes };
    });
  };

  // Location / Prop helpers
  const handleAddLocation = () => {
    const locId = `loc_${Date.now()}`;
    updateDoc((doc) => ({
      ...doc,
      locations: [...doc.locations, { id: locId, name: '', description: '' }],
    }));
  };

  const handleAddProp = () => {
    const propId = `prop_${Date.now()}`;
    updateDoc((doc) => ({
      ...doc,
      props: [...doc.props, { id: propId, name: '', description: '' }],
    }));
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50 dark:bg-[#090d16] text-slate-800 dark:text-slate-100">
      {/* Left Sidebar: Chapters Navigation */}
      <div className="w-64 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white dark:bg-[#0c1322] flex-shrink-0">
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clapperboard size={16} className="text-indigo-600 dark:text-indigo-400" />
            <span className="font-semibold text-sm">剧本章节列表</span>
          </div>
          <span className="text-xs text-slate-400">{chapters.length} 章</span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
          {chapters.map((ch) => {
            const isSelected = ch.id === selectedChapter?.id;
            return (
              <button
                key={ch.id}
                type="button"
                onClick={() => handleSelectChapter(ch)}
                className={`w-full text-left px-3 py-2.5 rounded-xl transition-all flex flex-col gap-1 text-xs ${
                  isSelected
                    ? 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 font-medium ring-1 ring-indigo-500/20 shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between w-full gap-2">
                  <span className="truncate font-medium text-sm">
                    第 {ch.index} 章 {ch.title}
                  </span>
                  {ch.status === 'completed' ? (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/40 flex-shrink-0">
                      {t('story.status_completed', '已定稿')}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700 flex-shrink-0">
                      {t('story.status_draft', '草稿')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <BookOpen size={11} />
                  <span>{ch.content ? `${ch.content.length} 字小说` : '暂无小说正文'}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Top Header Bar */}
        <div className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-[#0c1322]/80 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between gap-4 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {selectedChapter && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex-shrink-0">
                第 {selectedChapter.index} 章
              </span>
            )}
            {document && (
              <input
                type="text"
                value={document.title}
                onChange={(e) => updateDoc((doc) => ({ ...doc, title: e.target.value }))}
                className="font-semibold text-sm sm:text-base bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:outline-none px-1 py-0.5 transition-colors truncate max-w-xs sm:max-w-md"
                placeholder={t('script_editor.doc_title')}
              />
            )}
            {scriptData && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-mono font-medium border border-indigo-200 dark:border-indigo-800/60">
                  v{scriptData.revision}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    scriptData.status === 'confirmed'
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60'
                      : 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60'
                  }`}
                >
                  {scriptData.status === 'confirmed'
                    ? t('script_editor.status_confirmed')
                    : t('script_editor.status_draft')}
                </span>
                {isDirty && (
                  <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" title="有未保存修改" />
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setShowProsePanel(!showProsePanel)}
              className={`p-1.5 sm:px-2.5 sm:py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all border ${
                showProsePanel
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border-slate-300 dark:border-slate-700'
                  : 'bg-white dark:bg-slate-900 text-slate-500 border-slate-200 dark:border-slate-800 hover:text-slate-800'
              }`}
              title="切换小说原文对照侧栏"
            >
              <BookOpen size={14} />
              <span className="hidden md:inline">原文对照</span>
            </button>

            {scriptData && (
              <>
                <button
                  type="button"
                  onClick={handleGenerateOutline}
                  disabled={generatingOutline || generatingScript}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 flex items-center gap-1.5 transition-all disabled:opacity-50"
                  title={t('script_editor.ai_generate_outline')}
                >
                  <Sparkles size={14} className={generatingOutline ? 'animate-spin' : ''} />
                  <span className="hidden xl:inline">
                    {generatingOutline ? t('script_editor.generating_outline') : t('script_editor.ai_generate_outline')}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleGenerateScript}
                  disabled={generatingScript || generatingOutline}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-purple-50 dark:bg-purple-950/60 border border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/60 flex items-center gap-1.5 transition-all disabled:opacity-50"
                  title={t('script_editor.ai_generate_script')}
                >
                  <Sparkles size={14} className={generatingScript ? 'animate-spin' : ''} />
                  <span className="hidden xl:inline">
                    {generatingScript ? t('script_editor.generating_script') : t('script_editor.ai_generate_script')}
                  </span>
                </button>

                {scriptData.status === 'confirmed' && (
                  <button
                    type="button"
                    onClick={handleGenerateStoryboard}
                    disabled={generatingStoryboard || scriptData.freshness?.sourceChanged}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-amber-50 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60 flex items-center gap-1.5 transition-all disabled:opacity-50"
                    title={
                      scriptData.freshness?.sourceChanged
                        ? '剧本来源已过期，请核对更新剧本后再生成分镜候选'
                        : t('script_editor.ai_generate_storyboard')
                    }
                  >
                    <Clapperboard size={14} className={generatingStoryboard ? 'animate-spin' : ''} />
                    <span className="hidden xl:inline">
                      {generatingStoryboard ? t('script_editor.generating_storyboard') : t('script_editor.ai_generate_storyboard')}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleOpenExport}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 transition-all"
                  title={t('script_editor.export_md')}
                >
                  <Download size={14} />
                  <span className="hidden sm:inline">导出</span>
                </button>

                <button
                  type="button"
                  onClick={handleRestore}
                  disabled={restoring}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5 transition-all"
                  title={t('script_editor.restore_btn')}
                >
                  <RotateCcw size={14} className={restoring ? 'animate-spin' : ''} />
                  <span className="hidden lg:inline">{t('script_editor.restore_btn')}</span>
                </button>

                <button
                  type="button"
                  onClick={handleConfirmClick}
                  disabled={confirming}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 shadow-xs transition-all disabled:opacity-50"
                  title={t('script_editor.confirm_script')}
                >
                  <CheckCircle2 size={14} />
                  <span className="hidden sm:inline">
                    {confirming ? t('script_editor.confirming') : t('script_editor.confirm_script')}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!isDirty || saving}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 shadow-xs transition-all disabled:opacity-50"
                  title={t('script_editor.save_draft')}
                >
                  <Save size={14} />
                  <span>{saving ? t('script_editor.saving') : t('script_editor.save_draft')}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Pending Candidate Review Cards */}
        {scriptData?.pendingChanges && scriptData.pendingChanges.length > 0 && (
          <div className="bg-indigo-50/80 dark:bg-indigo-950/40 border-b border-indigo-200 dark:border-indigo-900/60 p-3 sm:px-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-bold text-indigo-900 dark:text-indigo-200">
                <GitPullRequest size={15} className="text-indigo-600 dark:text-indigo-400" />
                <span>{t('script_editor.pending_candidate_title')} ({scriptData.pendingChanges.length})</span>
              </div>
              <span className="text-[11px] text-indigo-600/80 dark:text-indigo-400/80">审核并确认后合并入正式剧本</span>
            </div>

            {scriptData.pendingChanges.map((cand) => {
              let parsedPayload: any = null;
              try {
                parsedPayload = JSON.parse(cand.after_json);
              } catch {
                parsedPayload = null;
              }

              const isExpanded = expandedCandidateId === cand.id;
              const isApplying = applyingChangeId === cand.id;
              const isDiscarding = discardingChangeId === cand.id;

              const isTimelineBlocked =
                cand.kind === 'storyboard' &&
                timelineSceneCount !== null &&
                timelineSceneCount > 0;

              const kindLabel =
                cand.kind === 'outline'
                  ? t('script_editor.candidate_kind_outline')
                  : cand.kind === 'script'
                  ? t('script_editor.candidate_kind_script')
                  : cand.kind === 'scene'
                  ? t('script_editor.candidate_kind_scene')
                  : cand.kind === 'storyboard'
                  ? t('script_editor.candidate_kind_storyboard')
                  : cand.kind;

              return (
                <div
                  key={cand.id}
                  className="bg-white dark:bg-slate-900 rounded-xl border border-indigo-200/80 dark:border-indigo-800/80 p-3 text-xs shadow-xs space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full font-semibold text-[11px] ${
                        cand.kind === 'storyboard'
                          ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300'
                          : 'bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300'
                      }`}>
                        {kindLabel}
                      </span>
                      <span className="text-slate-500 font-mono text-[10px]">
                        ID: {cand.id.slice(0, 8)}... (c_v{cand.candidate_revision})
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {isTimelineBlocked && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                          ⚠️ 现有 {timelineSceneCount} 镜，受空时间线保护
                        </span>
                      )}

                      <button
                        type="button"
                        onClick={() => setExpandedCandidateId(isExpanded ? null : cand.id)}
                        className="px-2 py-1 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 transition-colors"
                      >
                        {isExpanded ? <EyeOff size={13} /> : <Eye size={13} />}
                        <span>{isExpanded ? t('script_editor.hide_candidate_details') : t('script_editor.view_candidate_details')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          if (editingCandidateId === cand.id) {
                            setEditingCandidateId(null);
                          } else {
                            handleStartEditCandidate(cand, parsedPayload);
                          }
                        }}
                        disabled={isDiscarding || isApplying}
                        className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors ${
                          editingCandidateId === cand.id
                            ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-800'
                            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >
                        <Edit3 size={13} />
                        <span>{editingCandidateId === cand.id ? '取消编辑' : '编辑'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDiscardCandidate(cand)}
                        disabled={isDiscarding || isApplying}
                        className="px-2.5 py-1 rounded-md text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-center gap-1 transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={13} />
                        <span>{isDiscarding ? t('script_editor.discarding_candidate') : t('script_editor.discard_candidate')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleApplyCandidate(cand)}
                        disabled={isApplying || isDiscarding || isTimelineBlocked}
                        className={`px-3 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 shadow-xs transition-colors disabled:opacity-50 ${
                          cand.kind === 'storyboard'
                            ? 'bg-amber-600 hover:bg-amber-700 text-white'
                            : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                        }`}
                        title={isTimelineBlocked ? t('script_editor.timeline_not_empty_warning') : ''}
                      >
                        <Check size={13} />
                        <span>
                          {cand.kind === 'storyboard'
                            ? isApplying
                              ? t('script_editor.submitting_to_timeline')
                              : t('script_editor.submit_to_timeline')
                            : isApplying
                            ? t('script_editor.applying_candidate')
                            : t('script_editor.apply_candidate')}
                        </span>
                      </button>
                    </div>
                  </div>

                  {editingCandidateId === cand.id ? (
                    <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-indigo-300 dark:border-indigo-800 mt-2 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                          编辑候选内容 (JSON 结构)
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">
                          目标候选版本: v{cand.candidate_revision}
                        </span>
                      </div>
                      <textarea
                        value={editingCandidateJson}
                        onChange={(e) => setEditingCandidateJson(e.target.value)}
                        className="w-full h-56 font-mono text-[11px] p-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md focus:outline-hidden focus:ring-1 focus:ring-indigo-500 custom-scrollbar text-slate-800 dark:text-slate-200"
                        placeholder="请输入合法的 JSON 格式候选内容..."
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingCandidateId(null)}
                          className="px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-md transition-colors"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveCandidateEdit(cand)}
                          disabled={isSavingCandidate}
                          className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-md flex items-center gap-1 shadow-xs transition-colors disabled:opacity-50"
                        >
                          <Save size={13} />
                          <span>{isSavingCandidate ? '保存中...' : '保存候选修改'}</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Quick Summary */}
                      {cand.kind === 'outline' && parsedPayload && (
                        <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60">
                          <p className="font-semibold text-slate-800 dark:text-slate-200">
                            一句话梗概：<span className="font-normal">{parsedPayload.logline || '无'}</span>
                          </p>
                          <div className="flex flex-wrap gap-4 mt-1 text-[11px] text-slate-500">
                            <span>保留事件：{parsedPayload.mustKeepEvents?.length || 0} 个</span>
                            <span>戏剧节拍：{parsedPayload.beats?.length || 0} 场</span>
                            <span>结尾钩子：{parsedPayload.endingHook || '无'}</span>
                          </div>
                        </div>
                      )}

                      {cand.kind === 'script' && parsedPayload && (
                        <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60 flex flex-wrap gap-4 text-[11px]">
                          <span>标题：<strong className="text-slate-900 dark:text-white">{parsedPayload.title}</strong></span>
                          <span>分场数：{parsedPayload.scenes?.length || 0} 场</span>
                          <span>地点：{parsedPayload.locations?.length || 0} 个</span>
                          <span>预估时长：{parsedPayload.targetDurationSec || 120} 秒</span>
                        </div>
                      )}

                      {cand.kind === 'scene' && parsedPayload && (
                        <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-200/60 dark:border-slate-800/60 flex flex-wrap gap-4 text-[11px]">
                          <span>改写目标场：<strong className="text-slate-900 dark:text-white">{parsedPayload.id}</strong></span>
                          <span>场景：{parsedPayload.interiorExterior === 'exterior' ? '外景' : '内景'} · {parsedPayload.timeOfDay}</span>
                          <span>动作/对白块数：{parsedPayload.blocks?.length || 0}</span>
                          <span>预计时长：{parsedPayload.estimatedDurationSec || 30} 秒</span>
                        </div>
                      )}

                      {cand.kind === 'storyboard' && parsedPayload && (
                        <div className="text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 p-2.5 rounded-lg border border-slate-200/60 dark:border-slate-800/60 space-y-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="font-semibold text-slate-800 dark:text-slate-200">
                              导演分镜契约：<span className="font-normal">{parsedPayload.shots?.length || 0} 镜（总时长约 {parsedPayload.totalDuration || 0} 秒）</span>
                            </p>
                            <span className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">
                              剧本预估时长: {parsedPayload.estimatedScriptDuration || 0} 秒
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-4 text-[11px] text-slate-500">
                            <span>已覆盖分场：{parsedPayload.coverageReport?.coveredSceneIds?.length || 0} / {parsedPayload.coverageReport?.totalScenes || 0} 场</span>
                            <span>已覆盖有声内容块：{parsedPayload.coverageReport?.coveredBlockIds?.length || 0} / {parsedPayload.coverageReport?.totalAudibleBlocks || 0} 条</span>
                            <span>核心保留事件：{parsedPayload.coverageReport?.coveredMustKeepEventIds?.length || 0} / {parsedPayload.coverageReport?.totalMustKeepEvents || 0} 项</span>
                          </div>
                        </div>
                      )}

                      {/* Expanded Detail view */}
                      {isExpanded && (
                        cand.kind === 'storyboard' && parsedPayload?.shots ? (
                          <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-lg border border-indigo-200 dark:border-indigo-900 mt-2 space-y-2">
                            <span className="font-semibold text-xs text-indigo-600 dark:text-indigo-400 block mb-1">
                              分镜镜头清单 ({parsedPayload.shots.length} 镜)
                            </span>
                            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 custom-scrollbar">
                              {parsedPayload.shots.map((shot: any, sIdx: number) => {
                                let specIntent = '';
                                try {
                                  if (shot.shot_spec) specIntent = JSON.parse(shot.shot_spec).shot_intent;
                                } catch {}
                                return (
                                  <div key={sIdx} className="bg-white dark:bg-slate-900 p-2.5 rounded-md border border-slate-200 dark:border-slate-800 text-[11px] space-y-1">
                                    <div className="flex items-center justify-between font-semibold text-indigo-600 dark:text-indigo-400">
                                      <span>镜头 #{shot.index} · {shot.shot_type || 'Medium Shot'} {specIntent ? `(${specIntent})` : ''}</span>
                                      <span className="text-slate-400 font-normal">分场: {shot.script_scene_id} · {shot.duration}s</span>
                                    </div>
                                    <div className="text-slate-700 dark:text-slate-300"><span className="text-slate-400">画面:</span> {shot.location} · {shot.primary_action}</div>
                                    {shot.dialogue && <div className="text-emerald-700 dark:text-emerald-400"><span className="text-slate-400">对白:</span> {shot.dialogue}</div>}
                                    {shot.narration && <div className="text-blue-700 dark:text-blue-400"><span className="text-slate-400">画外音:</span> {shot.narration}</div>}
                                    {shot.audio_prompt && <div className="text-amber-700 dark:text-amber-400"><span className="text-slate-400">音效:</span> {shot.audio_prompt}</div>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <pre className="p-2.5 rounded-lg bg-slate-100 dark:bg-slate-950 font-mono text-[11px] text-slate-700 dark:text-slate-300 overflow-x-auto max-h-60 custom-scrollbar border border-slate-200 dark:border-slate-800">
                            {JSON.stringify(parsedPayload, null, 2)}
                          </pre>
                        )
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Source Changed Warning Banner */}
        {scriptData?.freshness?.sourceChanged && (
          <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/60 px-4 py-2 flex items-center justify-between text-xs text-amber-800 dark:text-amber-300">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <span>{t('script_editor.source_changed_warning')}</span>
            </div>
            <button
              type="button"
              onClick={handleRefreshSource}
              disabled={refreshingSource}
              className="text-xs px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-md font-medium transition-colors disabled:opacity-50"
            >
              {refreshingSource ? '更新中...' : '更新来源快照'}
            </button>
          </div>
        )}

        {/* Workspace Body */}
        <div className="flex-1 flex overflow-hidden">
          {/* Main Editing Panels */}
          <div className="flex-1 flex flex-col h-full overflow-hidden">
            {!scriptData && !loading && (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4">
                  <Clapperboard size={32} />
                </div>
                <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100 mb-2">
                  {t('script_editor.not_created_title')}
                </h3>
                <p className="text-xs text-slate-500 max-w-md mb-6 leading-relaxed">
                  {t('script_editor.not_created_desc')}
                </p>
                <button
                  type="button"
                  onClick={handleCreateScript}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm font-medium flex items-center gap-2 shadow-md shadow-indigo-500/20 transition-all"
                >
                  <Plus size={16} />
                  {t('script_editor.create_script_btn')}
                </button>
              </div>
            )}

            {scriptData && document && (
              <>
                {/* Tabs Bar */}
                <div className="flex items-center px-4 sm:px-6 pt-3 border-b border-slate-200 dark:border-slate-800 gap-4 bg-slate-50/50 dark:bg-[#090d16]/50">
                  <button
                    type="button"
                    onClick={() => setActiveTab('scenes')}
                    className={`pb-2 text-xs sm:text-sm font-medium transition-all relative ${
                      activeTab === 'scenes'
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Layers size={14} />
                      {t('script_editor.tab_scenes')}
                      <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-800">
                        {document.scenes.length}
                      </span>
                    </span>
                    {activeTab === 'scenes' && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 rounded-full" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('outline')}
                    className={`pb-2 text-xs sm:text-sm font-medium transition-all relative ${
                      activeTab === 'outline'
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <BookOpen size={14} />
                      {t('script_editor.tab_outline')}
                    </span>
                    {activeTab === 'outline' && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 rounded-full" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setActiveTab('locations_props')}
                    className={`pb-2 text-xs sm:text-sm font-medium transition-all relative ${
                      activeTab === 'locations_props'
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <MapPin size={14} />
                      {t('script_editor.tab_locations_props')}
                      <span className="text-[11px] px-1.5 py-0.2 rounded-full bg-slate-200 dark:bg-slate-800">
                        {document.locations.length + document.props.length}
                      </span>
                    </span>
                    {activeTab === 'locations_props' && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-600 rounded-full" />
                    )}
                  </button>
                </div>

                {/* Tab 1: Scenes View */}
                {activeTab === 'scenes' && (
                  <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 custom-scrollbar">
                    {document.scenes.map((scene, sIdx) => {
                      const locationName =
                        document.locations.find((l) => l.id === scene.locationId)?.name ||
                        scene.locationId ||
                        '未选地点';

                      return (
                        <div
                          key={scene.id}
                          onClick={() => setSelectedSceneId(scene.id)}
                          className={`bg-white dark:bg-[#0c1322] border rounded-2xl p-4 sm:p-5 shadow-xs transition-all ${
                            selectedSceneId === scene.id
                              ? 'border-indigo-400 dark:border-indigo-500'
                              : 'border-slate-200 dark:border-slate-800'
                          }`}
                        >
                          {/* Scene Header */}
                          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800/80 mb-4">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                                第 {sIdx + 1} 场
                              </span>
                              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">
                                {scene.id}
                              </span>
                            </div>

                            {/* Scene Meta Controls */}
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              {/* Interior / Exterior */}
                              <select
                                value={scene.interiorExterior}
                                onChange={(e) =>
                                  handleUpdateSceneMeta(
                                    sIdx,
                                    'interiorExterior',
                                    e.target.value as any
                                  )
                                }
                                className="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                              >
                                <option value="interior">{t('script_editor.in_out_interior')}</option>
                                <option value="exterior">{t('script_editor.in_out_exterior')}</option>
                              </select>

                              {/* Location */}
                              <select
                                value={scene.locationId}
                                onChange={(e) =>
                                  handleUpdateSceneMeta(sIdx, 'locationId', e.target.value)
                                }
                                className="px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 max-w-[130px]"
                              >
                                <option value="">选择地点...</option>
                                {document.locations.map((loc) => (
                                  <option key={loc.id} value={loc.id}>
                                    {loc.name || loc.id}
                                  </option>
                                ))}
                              </select>

                              {/* Time of Day */}
                              <input
                                type="text"
                                value={scene.timeOfDay}
                                onChange={(e) =>
                                  handleUpdateSceneMeta(sIdx, 'timeOfDay', e.target.value)
                                }
                                placeholder="日/夜"
                                className="w-16 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-center"
                              />

                              {/* Estimated Duration */}
                              <div className="flex items-center gap-1 text-slate-400">
                                <Activity size={13} />
                                <input
                                  type="number"
                                  value={scene.estimatedDurationSec || 30}
                                  onChange={(e) =>
                                    handleUpdateSceneMeta(
                                      sIdx,
                                      'estimatedDurationSec',
                                      parseInt(e.target.value, 10) || 30
                                    )
                                  }
                                  className="w-14 px-1.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-center"
                                />
                                <span className="text-[11px]">秒</span>
                              </div>

                              {/* Reorder / Delete */}
                              <div className="flex items-center gap-1 ml-2">
                                <button
                                  type="button"
                                  onClick={() => handleRewriteScene(scene.id)}
                                  disabled={rewritingSceneId === scene.id}
                                  className="px-2 py-1 rounded-lg text-[11px] font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/40 border border-purple-200 dark:border-purple-800/60 flex items-center gap-1 transition-colors disabled:opacity-50"
                                  title={t('script_editor.ai_rewrite_scene')}
                                >
                                  <Sparkles size={13} className={rewritingSceneId === scene.id ? 'animate-spin' : ''} />
                                  <span className="hidden sm:inline">
                                    {rewritingSceneId === scene.id ? t('script_editor.rewriting_scene') : t('script_editor.ai_rewrite_scene')}
                                  </span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleMoveScene(sIdx, 'up')}
                                  disabled={sIdx === 0}
                                  className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"
                                  title={t('script_editor.move_up')}
                                >
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleMoveScene(sIdx, 'down')}
                                  disabled={sIdx === document.scenes.length - 1}
                                  className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"
                                  title={t('script_editor.move_down')}
                                >
                                  <ArrowDown size={14} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteScene(sIdx)}
                                  className="p-1 rounded text-red-400 hover:text-red-600 transition-colors"
                                  title="删除此场"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          </div>

                          {/* Cast Selection Chips */}
                          <div className="mb-4 flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] text-slate-400 flex items-center gap-1 mr-1">
                              <Clapperboard size={12} />
                              {t('script_editor.cast')}:
                            </span>
                            {characters.map((char) => {
                              const inCast = scene.characterIds.includes(char.id);
                              return (
                                <button
                                  key={char.id}
                                  type="button"
                                  onClick={() => handleToggleSceneCast(sIdx, char.id)}
                                  className={`text-[11px] px-2 py-0.5 rounded-full transition-all border ${
                                    inCast
                                      ? 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-400 border-indigo-300 dark:border-indigo-700 font-medium'
                                      : 'bg-slate-50 dark:bg-slate-800/40 text-slate-500 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                                  }`}
                                >
                                  {char.name}
                                </button>
                              );
                            })}
                          </div>

                          {/* Scene Blocks */}
                          <div className="space-y-3">
                            {scene.blocks.map((block, bIdx) => {
                              return (
                                <div
                                  key={block.id}
                                  className={`p-3 rounded-xl border transition-all text-xs ${
                                    block.type === 'action'
                                      ? 'bg-blue-50/40 dark:bg-blue-950/20 border-blue-200/80 dark:border-blue-900/50'
                                      : block.type === 'dialogue'
                                      ? 'bg-amber-50/40 dark:bg-amber-950/20 border-amber-200/80 dark:border-amber-900/50'
                                      : block.type === 'voiceover'
                                      ? 'bg-purple-50/40 dark:bg-purple-950/20 border-purple-200/80 dark:border-purple-900/50'
                                      : 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200/80 dark:border-emerald-900/50'
                                  }`}
                                >
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2">
                                      <span
                                        className={`font-semibold text-[11px] px-1.5 py-0.5 rounded ${
                                          block.type === 'action'
                                            ? 'bg-blue-100 dark:bg-blue-900/60 text-blue-700 dark:text-blue-300'
                                            : block.type === 'dialogue'
                                            ? 'bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300'
                                            : block.type === 'voiceover'
                                            ? 'bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300'
                                            : 'bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300'
                                        }`}
                                      >
                                        {block.type === 'action' && '动作 ACTION'}
                                        {block.type === 'dialogue' && '对白 DIALOGUE'}
                                        {block.type === 'voiceover' && '画外音 VOICEOVER'}
                                        {block.type === 'sound' && '音效 SOUND'}
                                      </span>

                                      {/* Dialogue specific controls */}
                                      {block.type === 'dialogue' && (
                                        <div className="flex items-center gap-2">
                                          <select
                                            value={block.characterId}
                                            onChange={(e) =>
                                              handleUpdateBlock(sIdx, bIdx, {
                                                characterId: parseInt(e.target.value, 10),
                                              })
                                            }
                                            className="px-2 py-0.5 rounded border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-900 text-xs font-medium"
                                          >
                                            {characters.map((c) => (
                                              <option key={c.id} value={c.id}>
                                                {c.name}
                                              </option>
                                            ))}
                                          </select>
                                          <input
                                            type="text"
                                            value={block.delivery || ''}
                                            onChange={(e) =>
                                              handleUpdateBlock(sIdx, bIdx, {
                                                delivery: e.target.value,
                                              })
                                            }
                                            placeholder="神态指示（如：冷笑）"
                                            className="w-36 px-2 py-0.5 rounded border border-amber-200 dark:border-amber-900 bg-white dark:bg-slate-900 text-xs"
                                          />
                                        </div>
                                      )}

                                      {/* Voiceover specific controls */}
                                      {block.type === 'voiceover' && (
                                        <select
                                          value={block.characterId ?? ''}
                                          onChange={(e) =>
                                            handleUpdateBlock(sIdx, bIdx, {
                                              characterId: e.target.value
                                                ? parseInt(e.target.value, 10)
                                                : null,
                                            })
                                          }
                                          className="px-2 py-0.5 rounded border border-purple-300 dark:border-purple-800 bg-white dark:bg-slate-900 text-xs font-medium"
                                        >
                                          <option value="">旁白 (Narrator)</option>
                                          {characters.map((c) => (
                                            <option key={c.id} value={c.id}>
                                              {c.name} (画外音)
                                            </option>
                                          ))}
                                        </select>
                                      )}
                                    </div>

                                    {/* Block controls */}
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        onClick={() => handleMoveBlock(sIdx, bIdx, 'up')}
                                        disabled={bIdx === 0}
                                        className="p-0.5 rounded text-slate-400 hover:text-slate-600 disabled:opacity-30"
                                      >
                                        <ArrowUp size={12} />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleMoveBlock(sIdx, bIdx, 'down')}
                                        disabled={bIdx === scene.blocks.length - 1}
                                        className="p-0.5 rounded text-slate-400 hover:text-slate-600 disabled:opacity-30"
                                      >
                                        <ArrowDown size={12} />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteBlock(sIdx, bIdx)}
                                        className="p-0.5 rounded text-red-400 hover:text-red-600"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    </div>
                                  </div>

                                  {/* Block text input */}
                                  <textarea
                                    value={block.text}
                                    onChange={(e) =>
                                      handleUpdateBlock(sIdx, bIdx, { text: e.target.value })
                                    }
                                    rows={block.type === 'action' ? 3 : 2}
                                    className="w-full p-2 rounded-lg border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none resize-y"
                                    placeholder={
                                      block.type === 'action'
                                        ? t('script_editor.action_placeholder')
                                        : block.type === 'dialogue'
                                        ? t('script_editor.dialogue_placeholder')
                                        : block.type === 'voiceover'
                                        ? t('script_editor.voiceover_placeholder')
                                        : t('script_editor.sound_placeholder')
                                    }
                                  />
                                </div>
                              );
                            })}
                          </div>

                          {/* Add Block Toolbar */}
                          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center gap-2">
                            <span className="text-[11px] text-slate-400 mr-1">添加内容块:</span>
                            <button
                              type="button"
                              onClick={() => handleAddBlock(sIdx, 'action')}
                              className="px-2.5 py-1 rounded-lg text-xs bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 hover:bg-blue-100 border border-blue-200 dark:border-blue-900 font-medium transition-all"
                            >
                              {t('script_editor.add_block_action')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddBlock(sIdx, 'dialogue')}
                              className="px-2.5 py-1 rounded-lg text-xs bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 hover:bg-amber-100 border border-amber-200 dark:border-amber-900 font-medium transition-all"
                            >
                              {t('script_editor.add_block_dialogue')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddBlock(sIdx, 'voiceover')}
                              className="px-2.5 py-1 rounded-lg text-xs bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 hover:bg-purple-100 border border-purple-200 dark:border-purple-900 font-medium transition-all"
                            >
                              {t('script_editor.add_block_voiceover')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAddBlock(sIdx, 'sound')}
                              className="px-2.5 py-1 rounded-lg text-xs bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 border border-emerald-200 dark:border-emerald-900 font-medium transition-all"
                            >
                              {t('script_editor.add_block_sound')}
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {/* Add Scene Button */}
                    <div className="pt-2 pb-8 flex justify-center">
                      <button
                        type="button"
                        onClick={handleAddScene}
                        className="px-6 py-2.5 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-500 text-slate-600 dark:text-slate-300 hover:text-indigo-600 text-xs sm:text-sm font-medium flex items-center gap-2 transition-all"
                      >
                        <Plus size={16} />
                        {t('script_editor.add_scene')}
                      </button>
                    </div>
                  </div>
                )}

                {/* Tab 2: Outline View */}
                {activeTab === 'outline' && (
                  <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 custom-scrollbar">
                    {/* Logline */}
                    <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
                      <label className="block text-xs font-semibold mb-2">
                        {t('script_editor.outline_logline')}
                      </label>
                      <textarea
                        value={document.outline.logline}
                        onChange={(e) =>
                          updateDoc((doc) => ({
                            ...doc,
                            outline: { ...doc.outline, logline: e.target.value },
                          }))
                        }
                        rows={3}
                        className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                        placeholder={t('script_editor.outline_logline_placeholder')}
                      />
                    </div>

                    {/* Must-Keep Events */}
                    <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-semibold">
                          {t('script_editor.must_keep_events')}
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            const newId = `ev_${Date.now()}`;
                            updateDoc((doc) => ({
                              ...doc,
                              outline: {
                                ...doc.outline,
                                mustKeepEvents: [
                                  ...doc.outline.mustKeepEvents,
                                  { id: newId, text: '', sourceParagraphIds: [] },
                                ],
                              },
                            }));
                          }}
                          className="px-2.5 py-1 rounded-lg text-xs bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 flex items-center gap-1 font-medium"
                        >
                          <Plus size={12} />
                          {t('script_editor.add_event')}
                        </button>
                      </div>

                      <div className="space-y-2">
                        {document.outline.mustKeepEvents.map((ev, eIdx) => (
                          <div key={ev.id} className="flex items-center gap-2">
                            <span className="text-[11px] font-mono text-slate-400 w-12">
                              {ev.id}
                            </span>
                            <input
                              type="text"
                              value={ev.text}
                              onChange={(e) => {
                                const text = e.target.value;
                                updateDoc((doc) => {
                                  const events = [...doc.outline.mustKeepEvents];
                                  const item = events[eIdx];
                                  if (item) events[eIdx] = { ...item, text };
                                  return { ...doc, outline: { ...doc.outline, mustKeepEvents: events } };
                                });
                              }}
                              className="flex-1 p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                              placeholder={t('script_editor.event_text_placeholder')}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                updateDoc((doc) => {
                                  const events = [...doc.outline.mustKeepEvents];
                                  events.splice(eIdx, 1);
                                  return { ...doc, outline: { ...doc.outline, mustKeepEvents: events } };
                                });
                              }}
                              className="p-1 text-red-400 hover:text-red-600"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Dramatic Beats */}
                    <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-semibold">
                          {t('script_editor.dramatic_beats')}
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            const newId = `beat_${Date.now()}`;
                            updateDoc((doc) => ({
                              ...doc,
                              outline: {
                                ...doc.outline,
                                beats: [...doc.outline.beats, { id: newId, purpose: '', eventIds: [] }],
                              },
                            }));
                          }}
                          className="px-2.5 py-1 rounded-lg text-xs bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 flex items-center gap-1 font-medium"
                        >
                          <Plus size={12} />
                          {t('script_editor.add_beat')}
                        </button>
                      </div>

                      <div className="space-y-2">
                        {document.outline.beats.map((beat, bIdx) => (
                          <div key={beat.id} className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-slate-500 w-16">
                              第 {bIdx + 1} 拍
                            </span>
                            <input
                              type="text"
                              value={beat.purpose}
                              onChange={(e) => {
                                const purpose = e.target.value;
                                updateDoc((doc) => {
                                  const beats = [...doc.outline.beats];
                                  const item = beats[bIdx];
                                  if (item) beats[bIdx] = { ...item, purpose };
                                  return { ...doc, outline: { ...doc.outline, beats } };
                                });
                              }}
                              className="flex-1 p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs"
                              placeholder={t('script_editor.beat_purpose_placeholder')}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                updateDoc((doc) => {
                                  const beats = [...doc.outline.beats];
                                  beats.splice(bIdx, 1);
                                  return { ...doc, outline: { ...doc.outline, beats } };
                                });
                              }}
                              className="p-1 text-red-400 hover:text-red-600"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Ending Hook */}
                    <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
                      <label className="block text-xs font-semibold mb-2">
                        {t('script_editor.ending_hook')}
                      </label>
                      <textarea
                        value={document.outline.endingHook}
                        onChange={(e) =>
                          updateDoc((doc) => ({
                            ...doc,
                            outline: { ...doc.outline, endingHook: e.target.value },
                          }))
                        }
                        rows={2}
                        className="w-full p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                        placeholder={t('script_editor.ending_hook_placeholder')}
                      />
                    </div>
                  </div>
                )}

                {/* Tab 3: Locations & Props View */}
                {activeTab === 'locations_props' && (
                  <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 custom-scrollbar">
                    {/* Locations */}
                    <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-semibold">
                          {t('script_editor.locations_title')}
                        </label>
                        <button
                          type="button"
                          onClick={handleAddLocation}
                          className="px-2.5 py-1 rounded-lg text-xs bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 flex items-center gap-1 font-medium"
                        >
                          <Plus size={12} />
                          {t('script_editor.add_location')}
                        </button>
                      </div>

                      <div className="space-y-3">
                        {document.locations.map((loc, lIdx) => (
                          <div key={loc.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={loc.name}
                                onChange={(e) => {
                                  const name = e.target.value;
                                  updateDoc((doc) => {
                                    const locs = [...doc.locations];
                                    const item = locs[lIdx];
                                    if (item) locs[lIdx] = { ...item, name };
                                    return { ...doc, locations: locs };
                                  });
                                }}
                                className="flex-1 p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium"
                                placeholder={t('script_editor.location_name')}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  updateDoc((doc) => {
                                    const locs = [...doc.locations];
                                    locs.splice(lIdx, 1);
                                    return { ...doc, locations: locs };
                                  });
                                }}
                                className="p-1 text-red-400 hover:text-red-600"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                            <input
                              type="text"
                              value={loc.description}
                              onChange={(e) => {
                                const description = e.target.value;
                                updateDoc((doc) => {
                                  const locs = [...doc.locations];
                                  const item = locs[lIdx];
                                  if (item) locs[lIdx] = { ...item, description };
                                  return { ...doc, locations: locs };
                                });
                              }}
                              className="w-full p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-500"
                              placeholder={t('script_editor.location_desc')}
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Props */}
                    <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5">
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-semibold">
                          {t('script_editor.props_title')}
                        </label>
                        <button
                          type="button"
                          onClick={handleAddProp}
                          className="px-2.5 py-1 rounded-lg text-xs bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 flex items-center gap-1 font-medium"
                        >
                          <Plus size={12} />
                          {t('script_editor.add_prop')}
                        </button>
                      </div>

                      <div className="space-y-3">
                        {document.props.map((pr, pIdx) => (
                          <div key={pr.id} className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40 space-y-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={pr.name}
                                onChange={(e) => {
                                  const name = e.target.value;
                                  updateDoc((doc) => {
                                    const prs = [...doc.props];
                                    const item = prs[pIdx];
                                    if (item) prs[pIdx] = { ...item, name };
                                    return { ...doc, props: prs };
                                  });
                                }}
                                className="flex-1 p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs font-medium"
                                placeholder={t('script_editor.prop_name')}
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  updateDoc((doc) => {
                                    const prs = [...doc.props];
                                    prs.splice(pIdx, 1);
                                    return { ...doc, props: prs };
                                  });
                                }}
                                className="p-1 text-red-400 hover:text-red-600"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                            <input
                              type="text"
                              value={pr.description}
                              onChange={(e) => {
                                const description = e.target.value;
                                updateDoc((doc) => {
                                  const prs = [...doc.props];
                                  const item = prs[pIdx];
                                  if (item) prs[pIdx] = { ...item, description };
                                  return { ...doc, props: prs };
                                });
                              }}
                              className="w-full p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-slate-500"
                              placeholder={t('script_editor.prop_desc')}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right Collapsible Panel: Original Novel Story Prose (Read-Only) */}
          {showProsePanel && (
            <div className="w-80 lg:w-96 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0c1322] flex flex-col h-full flex-shrink-0">
              <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <BookOpen size={15} className="text-slate-500" />
                  <span className="font-semibold text-xs">
                    {t('script_editor.novel_prose_title')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowProsePanel(false)}
                  className="p-1 rounded text-slate-400 hover:text-slate-600"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="p-2 bg-slate-50/50 dark:bg-slate-900/30 border-b border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 leading-snug">
                {t('script_editor.novel_prose_desc')}
              </div>

              <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                {selectedChapter?.content ? (
                  <div className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed select-text font-serif">
                    {selectedChapter.content}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-xs text-slate-400">
                    {t('script_editor.novel_empty')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Markdown Export Modal */}
      {exportModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#0c1322] border border-slate-200 dark:border-slate-800 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Download size={16} className="text-indigo-600 dark:text-indigo-400" />
                <h3 className="font-semibold text-sm">
                  {t('script_editor.export_dialog_title')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setExportModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 bg-slate-50 dark:bg-slate-950 font-mono text-xs text-slate-800 dark:text-slate-200 whitespace-pre-wrap select-all custom-scrollbar">
              {markdownContent}
            </div>

            <div className="p-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2 bg-white dark:bg-[#0c1322]">
              <button
                type="button"
                onClick={handleCopyMarkdown}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1.5"
              >
                {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                {t('script_editor.copy_markdown')}
              </button>
              <button
                type="button"
                onClick={handleDownloadMarkdown}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5"
              >
                <Download size={14} />
                {t('script_editor.download_markdown')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm with Source Refresh Dialog */}
      {showConfirmPrompt && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#0c1322] border border-amber-300 dark:border-amber-900 rounded-2xl max-w-md w-full p-5 shadow-2xl">
            <div className="flex items-center gap-2.5 text-amber-600 dark:text-amber-400 mb-3">
              <AlertTriangle size={20} />
              <h4 className="font-semibold text-sm">来源新鲜度提示</h4>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-4">
              检测到当前章节的小说正文或项目设定在剧本同步后发生了修改。如果您确认沿用当前剧本，请点击“确认并更新来源快照”。
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmPrompt(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => executeConfirm(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white"
              >
                确认并更新快照
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
