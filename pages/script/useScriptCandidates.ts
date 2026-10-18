import { useState } from 'react';
import { api } from '../../services/api';
import { isProjectWorkUnloading, scriptWorkId, startProjectWork, useProjectWorkJobs } from '../../services/project_work_tracker';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import type { useScriptDocument } from './useScriptDocument';

type ScriptDocumentController = ReturnType<typeof useScriptDocument>;

export function useScriptCandidates(doc: ScriptDocumentController) {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const projectJobs = useProjectWorkJobs(doc.projectIdStr);
  const scriptJob = doc.selectedChapter
    ? projectJobs.find((job) => job.id === scriptWorkId(doc.selectedChapter!.id))
    : undefined;
  const generatingOutline = scriptJob?.kind === 'script_outline';
  const generatingScript = scriptJob?.kind === 'script_full';
  const rewritingSceneId =
    scriptJob?.kind === 'script_scene' && scriptJob.sceneId != null ? String(scriptJob.sceneId) : null;
  const scriptGenerationBusy = Boolean(scriptJob);
  const [applyingChangeId, setApplyingChangeId] = useState<string | null>(null);
  const [discardingChangeId, setDiscardingChangeId] = useState<string | null>(null);
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);
  const [editingCandidateId, setEditingCandidateId] = useState<string | null>(null);
  const [editingCandidateJson, setEditingCandidateJson] = useState('');
  const [isSavingCandidate, setIsSavingCandidate] = useState(false);

  const handleStartScriptWork = (kind: 'script_outline' | 'script_full' | 'script_scene', sceneId?: string) => {
    const { scriptData, selectedChapter, projectIdStr, isDirty, document, setSelectedSceneId } = doc;
    if (!scriptData || !selectedChapter || !projectIdStr) return;
    if (isDirty) {
      showToast(t('script_editor.save_before_candidate'), 'warning');
      return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    const expectedRevision = scriptData.revision;
    const chapterTitle = selectedChapter.title || '';
    const sceneIndex = sceneId ? (document?.scenes.findIndex((scene) => scene.id === sceneId) ?? -1) : -1;
    const detail = sceneIndex >= 0
      ? t('script_editor.scene_running_detail', { n: sceneIndex + 1 })
      : undefined;
    if (sceneId) setSelectedSceneId(sceneId);
    const apiKind = kind === 'script_outline' ? 'outline' : kind === 'script_full' ? 'script' : 'scene';
    const requestKey = sceneId
      ? `fe_scene_${targetScriptId}_${sceneId}_${Date.now()}`
      : `fe_${apiKind}_${targetScriptId}_${Date.now()}`;
    const started = startProjectWork(
      {
        id: scriptWorkId(targetChapterId),
        kind,
        projectId: projectIdStr,
        chapterId: targetChapterId,
        chapterTitle,
        detail,
        sceneId,
        scriptId: targetScriptId,
        requestKey,
        startedAt: Date.now(),
      },
      async () => {
        try {
          await api.createScriptCandidate(targetScriptId, {
            kind: apiKind,
            target_scene_id: sceneId,
            expected_revision: expectedRevision,
            request_key: requestKey,
          });
          if (isProjectWorkUnloading()) return;
          const successKey = kind === 'script_outline'
            ? 'script_editor.outline_ready'
            : kind === 'script_full'
              ? 'script_editor.script_ready'
              : 'script_editor.scene_ready';
          showToast(
            t(successKey, detail ? { scene: detail } : undefined),
            'success'
          );
        } catch (err: any) {
          if (isProjectWorkUnloading()) return;
          const failKey = kind === 'script_outline'
            ? 'script_editor.outline_failed'
            : kind === 'script_full'
              ? 'script_editor.script_failed'
              : 'script_editor.scene_failed';
          showToast(err.message || t(failKey), 'error');
        } finally {
          if (isProjectWorkUnloading()) return;
          window.dispatchEvent(
            new CustomEvent('novastory-script-candidate-finished', {
              detail: { projectId: projectIdStr, chapterId: targetChapterId },
            })
          );
        }
      }
    );
    if (!started) {
      showToast(t('script_editor.script_already_running'), 'info');
    }
  };

  const handleGenerateOutline = () => handleStartScriptWork('script_outline');
  const handleGenerateScript = () => handleStartScriptWork('script_full');
  const handleRewriteScene = (sceneId: string) => handleStartScriptWork('script_scene', sceneId);

  const handleApplyCandidate = async (candidate: any) => {
    const { scriptData, selectedChapter, setScriptData, setDocument, setIsDirty, setDirtyBaseRevision, selectedChapterRef, scriptDataRef } = doc;
    if (!scriptData || !selectedChapter) return;
    if (doc.isDirty) {
      const proceed = window.confirm('采纳候选将以候选内容更新正式剧本，当前未保存的临时输入将被覆盖。确定继续吗？');
      if (!proceed) return;
    }
    const targetScriptId = scriptData.id;
    const targetChapterId = selectedChapter.id;
    setApplyingChangeId(candidate.id);
    try {
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
    const { scriptData, selectedChapter, setScriptData, selectedChapterRef, scriptDataRef, loadScriptForChapter } = doc;
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
    const { scriptData, setScriptData } = doc;
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

  const pendingReview = (doc.scriptData?.pendingChanges || []).filter(
    (change) => change.kind !== 'storyboard'
  );

  return {
    generatingOutline,
    generatingScript,
    rewritingSceneId,
    scriptGenerationBusy,
    handleGenerateOutline,
    handleGenerateScript,
    handleRewriteScene,
    panel: {
      pendingReview,
      expandedCandidateId,
      setExpandedCandidateId,
      editingCandidateId,
      setEditingCandidateId,
      editingCandidateJson,
      setEditingCandidateJson,
      applyingChangeId,
      discardingChangeId,
      isSavingCandidate,
      onStartEdit: handleStartEditCandidate,
      onDiscard: handleDiscardCandidate,
      onApply: handleApplyCandidate,
      onSaveEdit: handleSaveCandidateEdit,
    },
  };
}
