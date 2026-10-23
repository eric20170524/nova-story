import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Save,
  Wand2,
  RefreshCw,
  Plus,
  FileText,
  Trash2,
  Clapperboard,
  ArrowUp,
  ArrowDown,
  Sparkles,
  BookOpen,
  Undo2,
  Redo2,
  ShieldAlert,
  ChevronDown,
  Film,
  ChevronUp,
  Feather,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import SimpleMDE from 'react-simplemde-editor';
import EasyMDE from 'easymde';
import { api } from '../services/api';
import { Chapter } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { useUndo } from '../hooks/useUndo';
import { useProjectAgentOptional } from '../contexts/ProjectAgentContext';
import { StoryPlanPanel } from '../components/story/StoryPlanPanel';
import { chapterEditorFields, isChapterEditorDirty, reconcileChapterEditorFields } from '../components/story/chapterEditorState';

const MDE_ICONS = {
  bold: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h9a4 4 0 0 1 0 8H6v-8Z"/><path d="M6 4h8a4 4 0 0 1 0 8H6V4Z"/></svg>',
  italic: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/></svg>',
  heading: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"/><path d="M6 4v16"/><path d="M18 4v16"/></svg>',
  quote: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>',
  ul: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>',
  ol: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="21" y1="6" y2="6"/><line x1="10" x2="21" y1="12" y2="12"/><line x1="10" x2="21" y1="18" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><circle cx="4" cy="18" r="1"/></svg>',
  preview: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  sideBySide: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>',
  fullscreen: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><polyline points="21 15 21 21 15 21"/><polyline points="3 9 3 3 9 3"/></svg>',
};

export const StoryEditor: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const agentCtx = useProjectAgentOptional();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [content, setContent, undo, redo, canUndo, canRedo, setContentWithoutHistory] = useUndo('');
  const [summary, setSummary] = useState('');
  const [summaryExpanded, setSummaryExpanded] = useState(true);
  const [title, setTitle] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [showAiMenu, setShowAiMenu] = useState(false);
  const aiMenuBtnRef = useRef<HTMLButtonElement>(null);
  const aiMenuPanelRef = useRef<HTMLDivElement>(null);
  const [aiMenuPos, setAiMenuPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);

  // Keep latest selection/content for async agent reload without stale closures
  const selectedChapterRef = useRef(selectedChapter);
  const editorFieldsRef = useRef({ title, summary, content });
  selectedChapterRef.current = selectedChapter;
  editorFieldsRef.current = { title, summary, content };

  const loadChapters = useCallback(
    async (opts?: { forceSync?: boolean }) => {
      if (!projectId) return;
      try {
        const data = await api.getChapters(Number(projectId));
        if (Array.isArray(data) && data.length > 0) {
          const sorted = data.sort((a, b) => a.index - b.index);
          setChapters(sorted);

          const savedChapterId = localStorage.getItem(
            `director_project_${projectId}_chapter`
          );
          const targetChapter =
            sorted.find((c) => c.id === savedChapterId) || sorted[0];

          const current = selectedChapterRef.current;
          if (!current) {
            setSelectedChapter(targetChapter);
            return;
          }

          const freshSelected =
            sorted.find((c) => c.id === current.id) || targetChapter;
          if (freshSelected.id === current.id) {
            const local = editorFieldsRef.current;
            const merged = reconcileChapterEditorFields(
              chapterEditorFields(current), local, chapterEditorFields(freshSelected), opts?.forceSync
            );
            setTitle(merged.title);
            setSummary(merged.summary);
            if (merged.content !== local.content) setContentWithoutHistory(merged.content);
          }
          setSelectedChapter(freshSelected);
        } else {
          setChapters([]);
        }
      } catch (err) {
        console.error('[StoryEditor] Could not load chapters', err);
        showToast(
          t('story.failed_load_chapters', 'Failed to load chapters'),
          'error'
        );
      }
    },
    [projectId, setContentWithoutHistory, showToast, t]
  );

  useEffect(() => {
    if (projectId) loadChapters();
  }, [projectId, loadChapters]);

  useEffect(() => {
    const onAgent = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.projectId && String(detail.projectId) !== String(projectId)) return;
      if (projectId) loadChapters(detail.affectsContent === false ? undefined : { forceSync: true });
    };
    window.addEventListener('novastory-agent-data-changed', onAgent);
    return () => window.removeEventListener('novastory-agent-data-changed', onAgent);
  }, [projectId, loadChapters]);

  useEffect(() => {
    if (selectedChapter) {
      setContentWithoutHistory(selectedChapter.content || '');
      setSummary(selectedChapter.summary || '');
      setTitle(selectedChapter.title || '');
      
      if (projectId) {
        localStorage.setItem(`director_project_${projectId}_chapter`, selectedChapter.id);
        agentCtx?.setActiveChapterId(selectedChapter.id);
      }
    } else {
      setContentWithoutHistory('');
      setSummary('');
      setTitle('');
    }
  }, [selectedChapter?.id, projectId]);

  // Register apply bridge once; read latest setters/t via refs to avoid effect churn
  const applyBridgeRef = useRef({
    setContent,
    setContentWithoutHistory,
    showToast,
    t,
  });
  applyBridgeRef.current = {
    setContent,
    setContentWithoutHistory,
    showToast,
    t,
  };

  useEffect(() => {
    const register = agentCtx?.registerApplyHandler;
    if (!register) return;

    register((newContent, opts) => {
      const bridge = applyBridgeRef.current;
      // alreadyPersisted: executor wrote DB; reset undo baseline to avoid re-saving stale text
      if (opts?.alreadyPersisted) {
        bridge.setContentWithoutHistory(newContent);
        setSelectedChapter((prev) => {
          if (!prev) return prev;
          setChapters((chs) =>
            chs.map((c) =>
              c.id === prev.id ? { ...c, content: newContent } : c
            )
          );
          return { ...prev, content: newContent };
        });
        bridge.showToast(
          bridge.t('story.synced_from_agent', '改写已写入并同步到编辑器'),
          'success'
        );
      } else {
        bridge.setContent(newContent);
        bridge.showToast(
          bridge.t('story.applied_to_editor', '已应用到编辑器，请保存'),
          'success'
        );
      }
    });

    return () => {
      register(null);
    };
    // Only re-bind when provider identity changes (mount / project layout)
  }, [agentCtx?.registerApplyHandler]);

  const updateAiMenuPosition = useCallback(() => {
    const btn = aiMenuBtnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 8;
    const top = rect.bottom + gap;
    const right = Math.max(8, window.innerWidth - rect.right);
    const maxHeight = Math.max(160, window.innerHeight - top - 16);
    setAiMenuPos({ top, right, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!showAiMenu) {
      setAiMenuPos(null);
      return;
    }
    updateAiMenuPosition();
    const onReposition = () => updateAiMenuPosition();
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [showAiMenu, updateAiMenuPosition]);

  useEffect(() => {
    if (!showAiMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAiMenu(false);
    };
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (aiMenuBtnRef.current?.contains(target)) return;
      if (aiMenuPanelRef.current?.contains(target)) return;
      setShowAiMenu(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    // capture so CodeMirror doesn't swallow outside clicks
    document.addEventListener('mousedown', handlePointerDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown, true);
    };
  }, [showAiMenu]);

  const handleCreateChapter = async () => {
    if (!projectId) return;
    let currentChapters = chapters;
    if (isChapterEditorDirty(selectedChapter, { title, summary, content })) {
      if (!window.confirm(t('story.plan_dirty_confirm', '当前章节有未保存修改。保存并继续？'))) return;
      if (!(await handleSave({ silent: true }))) return;
      try {
        currentChapters = await api.getChapters(Number(projectId));
        setChapters(currentChapters);
      } catch (err) {
        showToast(t('story.failed_load_chapters', 'Failed to load chapters'), 'error');
        return;
      }
    }
    if (currentChapters.length > 0) {
      const lastChapter = currentChapters.reduce((last, chapter) => chapter.index > last.index ? chapter : last);
      const finalized = lastChapter.status === 'completed' && Boolean(lastChapter.finalized_content_hash);
      if (!finalized) {
        showToast(
          t(
            'story.prev_chapter_not_finalized_alert',
            `上一章（${lastChapter.title}）尚未定稿。章节定稿有严格次序，请先完成「定稿：更新世界观」后再创建新章。`
          ).replace('{title}', lastChapter.title),
          'warning'
        );
        return;
      }
    }
    const newIndex = currentChapters.length > 0 ? Math.max(...currentChapters.map(c => c.index)) + 1 : 1;
    const newChapterTitle = `${t('story.new_chapter_prefix', 'Chapter')} ${newIndex}`;
    try {
      const newChapter = await api.createChapter({
        id: crypto.randomUUID(),
        project_id: Number(projectId),
        title: newChapterTitle,
        content: '',
        index: newIndex
      });
      const updated = [...currentChapters, newChapter];
      setChapters(updated);
      setSelectedChapter(newChapter);
      showToast(t('story.chapter_created', 'Chapter created'), 'success');
    } catch (err: any) {
      console.error(err);
      showToast(err.message || t('story.failed_create_chapter', 'Failed to create chapter'), 'error');
    }
  };

  const handleDeleteChapter = async (e: React.MouseEvent, chapterId: string) => {
    e.stopPropagation();
    if (!confirm(t('story.confirm_delete_chapter', 'Are you sure you want to delete this chapter?'))) return;
    
    try {
      await api.deleteChapter(chapterId);
      const remaining = chapters.filter(c => c.id !== chapterId);
      setChapters(remaining);
      if (selectedChapter?.id === chapterId) {
        setSelectedChapter(remaining.length > 0 ? remaining[0] : null);
      }
      showToast(t('story.chapter_deleted', 'Chapter deleted'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('story.failed_delete_chapter', 'Failed to delete chapter'), 'error');
    }
  };

  const handleMoveChapter = async (e: React.MouseEvent, chapter: Chapter, direction: 'up' | 'down') => {
    e.stopPropagation();
    const currentIndex = chapters.findIndex(c => c.id === chapter.id);
    if (currentIndex < 0) return;
    
    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= chapters.length) return;
    
    const targetChapter = chapters[targetIndex];
    try {
      await api.moveChapter(chapter.id, targetChapter.index);
      await loadChapters();
      showToast(t('story.chapter_reordered', 'Chapter order updated'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('story.failed_move_chapter', 'Failed to move chapter'), 'error');
    }
  };

  const handleSave = async (opts?: { silent?: boolean }): Promise<boolean> => {
    if (!selectedChapter) return false;
    const submitted = { title, content, summary };
    try {
      const updated = await api.updateChapter(selectedChapter.id, submitted);
      if (selectedChapterRef.current?.id === updated.id) {
        const local = editorFieldsRef.current;
        const merged = reconcileChapterEditorFields(submitted, local, chapterEditorFields(updated));
        setTitle(merged.title);
        setSummary(merged.summary);
        if (merged.content !== local.content) setContentWithoutHistory(merged.content);
        setSelectedChapter(updated);
      }
      setChapters((current) => current.map(c => c.id === updated.id ? updated : c));
      if (!opts?.silent) {
        showToast(t('story.saved', 'Saved successfully'), 'success');
      }
      if (projectId) {
        window.dispatchEvent(new CustomEvent('novastory-story-plan-changed', {
          detail: { projectId },
        }));
      }
      return true;
    } catch (err) {
      console.error(err);
      showToast(t('story.failed_save', 'Failed to save'), 'error');
      return false;
    }
  };

  const handleAIDraft = async () => {
    if (!selectedChapter || !projectId) return;
    setAiLoading(true);
    try {
      const prompt = summary
        ? `Continue writing based on summary: ${summary}`
        : "Continue the story naturally from the current text. Respect chapter summary and do not spoil the next chapter.";
      const res = await api.draftText(content, prompt, {
        project_id: Number(projectId),
        chapter_id: selectedChapter.id,
        ...(selectedChapter.target_word_count ? { target_word_count: selectedChapter.target_word_count } : {}),
      });
      if (res?.content) {
        setContent(content ? `${content}\n\n${res.content}` : res.content);
        showToast(t('story.draft_ready', 'Draft generated'), 'success');
      }
    } catch (err) {
      console.error(err);
      showToast(t('story.draft_failed', 'Draft generation failed'), 'error');
    } finally {
      setAiLoading(false);
    }
  };

  const handleTriggerAgentAction = async (promptText: string) => {
    setShowAiMenu(false);
    if (selectedChapter) {
      const ok = await handleSave({ silent: true });
      if (!ok) return;
    }
    if (agentCtx) {
      agentCtx.setOpen(true);
      agentCtx.sendPrompt(promptText);
    }
  };

  /** Soft entry: open Director only — timeline generation stays on the director page */
  const handleOpenDirector = async () => {
    if (!projectId) return;
    if (selectedChapter) {
      await handleSave({ silent: true });
    }
    navigate(`/project/${projectId}/director`);
  };

  const wordCount = useMemo(() => {
    return (content || '').trim().replace(/\s+/g, '').length;
  }, [content]);

  const readingTime = useMemo(() => {
    return Math.max(1, Math.ceil(wordCount / 400));
  }, [wordCount]);

  const currentChapterIndex = useMemo(() => {
    if (!selectedChapter) return -1;
    return chapters.findIndex((ch) => ch.id === selectedChapter.id);
  }, [chapters, selectedChapter]);

  const editorOptions = useMemo<EasyMDE.Options>(() => ({
    spellChecker: false,
    status: false,
    placeholder: t('story.placeholder'),
    autoDownloadFontAwesome: false,
    lineWrapping: true,
    styleSelectedText: false,
    toolbar: [
      {
        name: 'bold',
        action: EasyMDE.toggleBold,
        className: 'custom-mde-btn',
        title: t('story.editor_bold', '粗体 (Ctrl+B)'),
        icon: MDE_ICONS.bold,
      },
      {
        name: 'italic',
        action: EasyMDE.toggleItalic,
        className: 'custom-mde-btn',
        title: t('story.editor_italic', '斜体 (Ctrl+I)'),
        icon: MDE_ICONS.italic,
      },
      {
        name: 'heading',
        action: EasyMDE.toggleHeadingSmaller,
        className: 'custom-mde-btn',
        title: t('story.editor_heading', '标题 (Ctrl+H)'),
        icon: MDE_ICONS.heading,
      },
      '|',
      {
        name: 'quote',
        action: EasyMDE.toggleBlockquote,
        className: 'custom-mde-btn',
        title: t('story.editor_quote', '引用 (Ctrl+\')'),
        icon: MDE_ICONS.quote,
      },
      {
        name: 'unordered-list',
        action: EasyMDE.toggleUnorderedList,
        className: 'custom-mde-btn',
        title: t('story.editor_ul', '无序列表 (Ctrl+L)'),
        icon: MDE_ICONS.ul,
      },
      {
        name: 'ordered-list',
        action: EasyMDE.toggleOrderedList,
        className: 'custom-mde-btn',
        title: t('story.editor_ol', '有序列表 (Alt+L)'),
        icon: MDE_ICONS.ol,
      },
      '|',
      {
        name: 'preview',
        action: EasyMDE.togglePreview,
        className: 'custom-mde-btn no-disable',
        title: t('story.editor_preview', '实时预览 (Ctrl+P)'),
        icon: MDE_ICONS.preview,
      },
      {
        name: 'side-by-side',
        action: EasyMDE.toggleSideBySide,
        className: 'custom-mde-btn no-disable no-mobile',
        title: t('story.editor_side_by_side', '分栏对照 (F9)'),
        icon: MDE_ICONS.sideBySide,
      },
      {
        name: 'fullscreen',
        action: EasyMDE.toggleFullScreen,
        className: 'custom-mde-btn no-disable no-mobile',
        title: t('story.editor_fullscreen', '全屏沉浸 (F11)'),
        icon: MDE_ICONS.fullscreen,
      },
    ],
  }), [t]);

  const lastChapter = chapters.length > 0 ? chapters[chapters.length - 1] : null;
  const isPrevChapterUnfinalized = Boolean(
    lastChapter && !(lastChapter.status === 'completed' && lastChapter.finalized_content_hash)
  );
  const editorDirty = isChapterEditorDirty(selectedChapter, { title, summary, content });
  const lastChapterTitle = lastChapter ? lastChapter.title : '';

  return (
    <div className="flex h-full w-full min-h-0 bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 transition-colors duration-200">
      {/* Chapter Sidebar */}
      <div className="w-16 lg:w-72 bg-white/90 dark:bg-[#0c1322]/90 border-r border-slate-200/80 dark:border-slate-800/80 flex flex-col flex-shrink-0 transition-all h-full min-h-0 backdrop-blur-sm">
        <div className="px-4 py-3 border-b border-slate-200/80 dark:border-slate-800/80 flex justify-between items-center h-14 flex-shrink-0">
          <div className="hidden lg:flex items-center gap-2">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 text-sm">{t('story.chapters')}</h3>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
              {chapters.length}
            </span>
          </div>
          <button
            onClick={handleCreateChapter}
            className={`p-1.5 rounded-xl mx-auto lg:mx-0 transition-all shadow-xs ${
              isPrevChapterUnfinalized
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/60'
                : 'bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/80 text-indigo-600 dark:text-indigo-400'
            }`}
            title={
              isPrevChapterUnfinalized
                ? t('story.cannot_create_unfinalized_tip', `上一章（${lastChapterTitle}）尚未定稿，请先完成定稿更新世界观`).replace('{title}', lastChapterTitle)
                : t('story.new_chapter', '新建章节')
            }
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar min-h-0">
          {chapters.map((chapter, index) => {
            const isSelected = selectedChapter?.id === chapter.id;
            const approxWords = (chapter.content || '').trim().replace(/\s+/g, '').length;
            return (
              <div
                key={chapter.id}
                onClick={() => setSelectedChapter(chapter)}
                className={`group flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer text-xs transition-all relative ${
                  isSelected 
                    ? 'bg-indigo-50/90 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 font-semibold shadow-xs ring-1 ring-indigo-500/30' 
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100/80 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
                title={chapter.title}
              >
                {isSelected && (
                  <span className="absolute left-0 top-2 bottom-2 w-1 bg-indigo-600 rounded-r-full" />
                )}

                <div className="flex items-center gap-2.5 overflow-hidden flex-1 min-w-0 pl-1">
                  <span className={`text-[10px] font-mono font-bold flex-shrink-0 w-5 text-center ${
                    isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'
                  }`}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="truncate flex-1 min-w-0 hidden lg:block">
                    <div className="truncate font-medium">{chapter.title}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                      <span>{approxWords} 字</span>
                    </div>
                  </div>
                  {chapter.status === 'completed' ? (
                    <span className="hidden lg:inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded-md bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/40 flex-shrink-0">
                      <CheckCircle2 size={10} />
                      <span>{t('story.status_completed', '已定稿')}</span>
                    </span>
                  ) : (
                    <span className="hidden lg:inline-flex items-center px-1.5 py-0.5 text-[9px] font-medium rounded-md bg-slate-100 text-slate-500 dark:bg-slate-800/90 dark:text-slate-400 border border-slate-200 dark:border-slate-700/60 flex-shrink-0">
                      {t('story.status_draft', '草稿')}
                    </span>
                  )}
                </div>
                
                <div className="hidden lg:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-1">
                  <button 
                    onClick={(e) => handleMoveChapter(e, chapter, 'up')}
                    disabled={index === 0}
                    className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-20 rounded hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
                    title="Move Up"
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button 
                    onClick={(e) => handleMoveChapter(e, chapter, 'down')}
                    disabled={index === chapters.length - 1}
                    className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-20 rounded hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
                    title="Move Down"
                  >
                    <ArrowDown size={11} />
                  </button>
                  <button 
                    onClick={(e) => handleDeleteChapter(e, chapter.id)}
                    className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                    title="Delete Chapter"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            );
          })}
          {chapters.length === 0 && (
            <div className="p-6 text-center text-xs text-slate-400 dark:text-slate-500 hidden lg:block">
              {t('story.no_chapters')}
            </div>
          )}
        </div>
      </div>

      {/* Main Full-Width Editor Area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-hidden">
        {projectId && (
          <StoryPlanPanel
            projectId={projectId}
            chapters={chapters}
            dirty={editorDirty}
            onSave={() => handleSave({ silent: true })}
            onChaptersChanged={() => loadChapters()}
          />
        )}
        {/* Editor Top Bar */}
        <div className="relative z-20 h-14 border-b border-slate-200/80 dark:border-slate-800/80 flex items-center justify-between px-3 sm:px-6 bg-white/80 dark:bg-[#0c1322]/80 backdrop-blur-md gap-3 flex-shrink-0">
          <input
            type="text"
            className="bg-transparent border-none text-slate-900 dark:text-white font-bold focus:ring-0 flex-1 min-w-0 text-sm sm:text-base truncate placeholder-slate-400"
            value={title}
            onChange={(e) => {
              const newTitle = e.target.value;
              if (selectedChapter) {
                setTitle(newTitle);
              }
            }}
            placeholder={t('story.chapter_title_placeholder')}
          />

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('story.undo', 'Undo')}
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t('story.redo', 'Redo')}
            >
              <Redo2 size={16} />
            </button>

            {/* Smart AI Actions Dropdown */}
            <div className="relative">
              <button
                ref={aiMenuBtnRef}
                type="button"
                aria-expanded={showAiMenu}
                aria-haspopup="menu"
                onClick={() => setShowAiMenu((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-xs font-semibold transition-all ${
                  showAiMenu
                    ? 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-200 border-indigo-300 dark:border-indigo-400/50 shadow-xs'
                    : 'bg-indigo-50/70 dark:bg-indigo-950/40 hover:bg-indigo-100 dark:hover:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800/40'
                }`}
                title={t('story.smart_ai_tools', '智能创作工具')}
              >
                <Sparkles size={14} className="text-indigo-600 dark:text-indigo-400" />
                <span className="hidden md:inline">{t('story.smart_ai_tools', '智能创作')}</span>
                <ChevronDown
                  size={13}
                  className={`text-indigo-600 dark:text-indigo-400 transition-transform duration-150 ${
                    showAiMenu ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {showAiMenu &&
                aiMenuPos &&
                createPortal(
                  <div
                    ref={aiMenuPanelRef}
                    role="menu"
                    style={{
                      position: 'fixed',
                      top: aiMenuPos.top,
                      right: aiMenuPos.right,
                      maxHeight: aiMenuPos.maxHeight,
                      zIndex: 200,
                    }}
                    className="w-64 overflow-y-auto overscroll-contain bg-white dark:bg-[#0f172a] border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl py-1.5 text-xs custom-scrollbar animate-in fade-in zoom-in-95 duration-150 origin-top-right"
                  >
                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider">
                      {t('story.ai_extraction_analysis', '分析与抽取')}
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_analyze_plot',
                            '请分析当前章节的剧情推进要点与新实体'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-600/20 hover:text-indigo-700 dark:hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Sparkles size={14} className="text-sky-500 dark:text-sky-400 flex-shrink-0" />
                      <span>{t('story.analyze_impact', '剧情深度分析')}</span>
                    </button>

                    <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />

                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider">
                      {t('story.skills', '写作技能')}
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_cinematic',
                            '请对当前章节进行电影化视听与感官改写，增强沉浸感'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-600/20 hover:text-indigo-700 dark:hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Film size={14} className="text-purple-500 dark:text-purple-400 flex-shrink-0" />
                      <span>{t('story.skill_cinematic', '电影化视听改写')}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_add_conflict',
                            '请为当前章节注入戏剧冲突与突发危机'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-600/20 hover:text-indigo-700 dark:hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Wand2 size={14} className="text-amber-500 dark:text-amber-400 flex-shrink-0" />
                      <span>{t('story.skill_conflict', '注入剧情冲突')}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_reverse_plot',
                            '请为当前章节结尾设计一个意料之外的情节反转'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-600/20 hover:text-indigo-700 dark:hover:text-indigo-200 flex items-center gap-2"
                    >
                      <RefreshCw size={14} className="text-rose-500 dark:text-rose-400 flex-shrink-0" />
                      <span>{t('story.skill_reversal', '设计情节反转')}</span>
                    </button>

                    <div className="h-px bg-slate-100 dark:bg-slate-800 my-1" />

                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-400 dark:text-slate-500 tracking-wider">
                      {t('story.world_consistency', '世界观与体检')}
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_consistency',
                            '请对全书所有章节进行逻辑一致性与设定漏洞体检'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-600/20 hover:text-indigo-700 dark:hover:text-indigo-200 flex items-center gap-2"
                    >
                      <ShieldAlert size={14} className="text-amber-500 dark:text-amber-400 flex-shrink-0" />
                      <span>{t('story.consistency_btn', '全书逻辑体检')}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_impact',
                            '本章已定稿，请提取角色（含性格特征）、世界观术语并更新到角色库与设定库，同时更新主线剧情时间线（角色状态、事件、伏笔）与人物关系'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-700 dark:text-slate-300 hover:bg-indigo-50 dark:hover:bg-indigo-600/20 hover:text-indigo-700 dark:hover:text-indigo-200 flex items-center gap-2"
                    >
                      <BookOpen size={14} className="text-emerald-500 dark:text-emerald-400 flex-shrink-0" />
                      <span>{t('story.impact_btn', '定稿：更新世界观')}</span>
                    </button>
                  </div>,
                  document.body
                )}
            </div>

            {/* Link to Director */}
            <button
              type="button"
              onClick={handleOpenDirector}
              disabled={!projectId}
              className="p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-30"
              title={t('story.open_director', '打开导演分镜工作台')}
            >
              <Clapperboard size={16} />
            </button>

            {/* Save Button */}
            <button 
              onClick={() => handleSave()}
              disabled={!selectedChapter}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-xl text-xs sm:text-sm font-semibold transition-all shadow-md shadow-indigo-500/20 disabled:opacity-40"
            >
              <Save size={14} /> 
              <span>{t('story.save')}</span>
            </button>

            {/* Finalize Worldview Button */}
            <button
              type="button"
              onClick={() =>
                handleTriggerAgentAction(
                  t(
                    'agent.prompt_impact',
                    '本章已定稿，请提取角色（含性格特征）、世界观术语并更新到角色库与设定库，同时更新主线剧情时间线（角色状态、事件、伏笔）与人物关系'
                  )
                )
              }
              disabled={!selectedChapter}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs sm:text-sm font-semibold transition-all shadow-md shadow-emerald-600/20 disabled:opacity-40"
              title={t('story.impact_btn', '定稿：更新世界观')}
            >
              <BookOpen size={14} />
              <span className="hidden sm:inline">{t('story.impact_btn', '定稿：更新世界观')}</span>
              <span className="sm:hidden">{t('story.impact_short', '定稿')}</span>
            </button>
          </div>
        </div>

        {/* Outline / Summary Bar (Collapsible) */}
        {selectedChapter && (
          <div className="border-b border-slate-200/80 dark:border-slate-800/80 bg-white/70 dark:bg-[#0c1322]/70 backdrop-blur-sm flex-shrink-0 transition-all">
            <div className="px-4 lg:px-6 py-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setSummaryExpanded((v) => !v)}
                className="flex items-center gap-2 text-left group/btn"
              >
                <span className="text-[11px] uppercase tracking-wider text-slate-600 dark:text-slate-300 font-bold group-hover/btn:text-indigo-600 dark:group-hover/btn:text-indigo-400 transition-colors flex items-center gap-1.5">
                  <Feather size={12} className="text-indigo-500" />
                  {t('story.chapter_summary', '本章剧情大纲 / 梗概')}
                </span>
                {!summaryExpanded && summary && (
                  <span className="text-xs text-slate-400 dark:text-slate-500 truncate max-w-md hidden sm:inline">
                    · {summary.slice(0, 40)}...
                  </span>
                )}
                {summaryExpanded ? (
                  <ChevronUp size={13} className="text-slate-400" />
                ) : (
                  <ChevronDown size={13} className="text-slate-400" />
                )}
              </button>
              <span className="text-[10px] text-slate-400 dark:text-slate-500 hidden sm:inline">
                {summaryExpanded ? '供智能体与分镜生成参考' : '点击展开编辑'}
              </span>
            </div>
            {summaryExpanded && (
              <div className="px-4 lg:px-6 pb-3 pt-0 animate-in fade-in duration-150">
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={2}
                  placeholder={t('story.summary_placeholder', '核心冲突、情节走向、结尾悬念…')}
                  className="w-full bg-slate-50/80 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2 text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 resize-none transition-all shadow-2xs"
                />
              </div>
            )}
          </div>
        )}
        
        {/* Editor Body - Paper Canvas on Tinted Desk Background */}
        <div className="flex-1 relative group/editor overflow-hidden flex flex-col min-h-0 bg-slate-100/70 dark:bg-[#070b13] p-2 sm:p-4 lg:p-6 overflow-y-auto">
          {selectedChapter ? (
            <div className="flex-1 flex flex-col max-w-5xl w-full mx-auto bg-white dark:bg-[#0c1322] rounded-2xl shadow-sm border border-slate-200/90 dark:border-slate-800/80 overflow-hidden min-h-0">
              <SimpleMDE
                key={selectedChapter.id}
                value={content}
                onChange={(val) => setContent(val)}
                options={editorOptions}
                className="h-full custom-simplemde"
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500 text-sm">
              {t('story.no_chapters')}
            </div>
          )}
          
          {/* AI Floating Quick Action Toolbar */}
          <div className="absolute bottom-6 right-36 flex items-center gap-2 z-20">
            <div className="hidden sm:flex items-center gap-1.5 px-3 py-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200/90 dark:border-slate-800 rounded-full text-xs font-medium text-slate-600 dark:text-slate-300 shadow-lg shadow-slate-900/5">
              <Clock size={13} className="text-indigo-500" />
              <span>{wordCount} 字</span>
            </div>
            <button
              onClick={handleAIDraft}
              disabled={aiLoading}
              className="bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white px-4 py-2.5 rounded-full shadow-xl shadow-indigo-600/30 transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 flex items-center gap-2 text-xs font-semibold"
              title={t('story.ai_continue', '沉浸续写')}
            >
              {aiLoading ? <RefreshCw className="animate-spin" size={15} /> : <Wand2 size={15} />}
              <span>{t('story.ai_continue', '沉浸续写')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};