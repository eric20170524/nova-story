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
  Users,
  Sparkles,
  BookOpen,
  Undo2,
  Redo2,
  ShieldAlert,
  Bot,
  ChevronDown,
  Film,
} from 'lucide-react';
import SimpleMDE from 'react-simplemde-editor';
import { api } from '../services/api';
import { Chapter } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import { useUndo } from '../hooks/useUndo';
import { useProjectAgentOptional } from '../contexts/ProjectAgentContext';

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
  const [aiLoading, setAiLoading] = useState(false);
  const [showAiMenu, setShowAiMenu] = useState(false);
  const aiMenuBtnRef = useRef<HTMLButtonElement>(null);
  const aiMenuPanelRef = useRef<HTMLDivElement>(null);
  const [aiMenuPos, setAiMenuPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);

  // Keep latest selection/content for async agent reload without stale closures
  const selectedChapterRef = useRef(selectedChapter);
  const contentRef = useRef(content);
  useEffect(() => {
    selectedChapterRef.current = selectedChapter;
  }, [selectedChapter]);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const loadChapters = useCallback(
    async (opts?: { syncEditorIfClean?: boolean; forceSync?: boolean }) => {
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
          const prevContent = current.content || '';
          const localContent = contentRef.current;
          const serverContent = freshSelected.content || '';

          setSelectedChapter(freshSelected);

          // Agent rewrites always force-pull server body into the editor.
          // Clean-only sync still avoids clobbering unsaved local typing.
          const shouldPull =
            freshSelected.id === current.id &&
            serverContent !== localContent &&
            (opts?.forceSync ||
              (opts?.syncEditorIfClean && localContent === prevContent));

          if (shouldPull) {
            setContentWithoutHistory(serverContent);
          }
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
    const onAgent = () => {
      if (projectId) loadChapters({ forceSync: true });
    };
    window.addEventListener('novastory-agent-data-changed', onAgent);
    return () => window.removeEventListener('novastory-agent-data-changed', onAgent);
  }, [projectId, loadChapters]);

  useEffect(() => {
    if (selectedChapter) {
      setContentWithoutHistory(selectedChapter.content || '');
      setSummary(selectedChapter.summary || '');
      
      if (projectId) {
        localStorage.setItem(`director_project_${projectId}_chapter`, selectedChapter.id);
        agentCtx?.setActiveChapterId(selectedChapter.id);
      }
    } else {
      setContentWithoutHistory('');
      setSummary('');
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
    const newIndex = chapters.length > 0 ? Math.max(...chapters.map(c => c.index)) + 1 : 1;
    const title = `${t('story.new_chapter_prefix', 'Chapter')} ${newIndex}`;
    try {
      const newChapter = await api.createChapter({
        id: crypto.randomUUID(),
        project_id: Number(projectId),
        title,
        content: '',
        index: newIndex
      });
      const updated = [...chapters, newChapter];
      setChapters(updated);
      setSelectedChapter(newChapter);
      showToast(t('story.chapter_created', 'Chapter created'), 'success');
    } catch (err) {
      console.error(err);
      showToast(t('story.failed_create_chapter', 'Failed to create chapter'), 'error');
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
    try {
      const updated = await api.updateChapter(selectedChapter.id, {
        title: selectedChapter.title,
        content,
        summary
      });
      setSelectedChapter(updated);
      setChapters(chapters.map(c => c.id === updated.id ? updated : c));
      if (!opts?.silent) {
        showToast(t('story.saved', 'Saved successfully'), 'success');
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
        target_word_count: 800,
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

  const editorOptions = useMemo(() => ({
    spellChecker: false,
    status: false,
    placeholder: t('story.placeholder'),
    toolbar: ["bold", "italic", "heading", "|", "quote", "unordered-list", "ordered-list", "|", "preview", "side-by-side", "fullscreen"],
    styleSelectedText: false,
    maxHeight: "100%",
  }), [t]);

  return (
    <div className="flex h-full bg-slate-950">
      {/* Chapter Sidebar */}
      <div className="w-16 lg:w-60 bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0 transition-all">
        <div className="p-4 border-b border-slate-800 flex justify-between items-center h-14">
          <h3 className="font-semibold text-slate-300 hidden lg:block text-sm">{t('story.chapters')}</h3>
          <button
            onClick={handleCreateChapter}
            className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white mx-auto lg:mx-0 transition-colors"
            title={t('story.new_chapter', '新建章节')}
          >
            <Plus size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
          {chapters.map((chapter, index) => (
            <div
              key={chapter.id}
              onClick={() => setSelectedChapter(chapter)}
              className={`group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer text-xs sm:text-sm transition-colors ${
                selectedChapter?.id === chapter.id 
                  ? 'bg-indigo-600/20 text-indigo-300 font-medium' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
              title={chapter.title}
            >
              <div className="flex items-center gap-2 overflow-hidden flex-1">
                <FileText size={16} className="flex-shrink-0" />
                <span className="truncate hidden lg:block">{chapter.title}</span>
              </div>
              
              <div className="hidden lg:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={(e) => handleMoveChapter(e, chapter, 'up')}
                  disabled={index === 0}
                  className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500"
                  title="Move Up"
                >
                  <ArrowUp size={12} />
                </button>
                <button 
                  onClick={(e) => handleMoveChapter(e, chapter, 'down')}
                  disabled={index === chapters.length - 1}
                  className="p-1 text-slate-500 hover:text-white disabled:opacity-30 disabled:hover:text-slate-500"
                  title="Move Down"
                >
                  <ArrowDown size={12} />
                </button>
                <button 
                  onClick={(e) => handleDeleteChapter(e, chapter.id)}
                  className="p-1 text-slate-500 hover:text-red-400 rounded transition-colors"
                  title="Delete Chapter"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
          {chapters.length === 0 && (
            <div className="p-4 text-center text-xs text-slate-600 hidden lg:block">{t('story.no_chapters')}</div>
          )}
        </div>
      </div>

      {/* Main Full-Width Editor Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Editor Top Bar — z-20 so bar chrome stays above editor; menu itself portals to body */}
        <div className="relative z-20 h-14 border-b border-slate-800 flex items-center justify-between px-3 sm:px-6 bg-slate-900/90 backdrop-blur gap-3 flex-shrink-0">
          <input
            type="text"
            className="bg-transparent border-none text-white font-medium focus:ring-0 flex-1 min-w-0 text-sm sm:text-base truncate"
            value={selectedChapter?.title || ''}
            onChange={(e) => {
              const newTitle = e.target.value;
              if (selectedChapter) {
                setSelectedChapter({ ...selectedChapter, title: newTitle });
                setChapters((prev) =>
                  prev.map((c) => (c.id === selectedChapter.id ? { ...c, title: newTitle } : c))
                );
              }
            }}
            placeholder={t('story.chapter_title_placeholder')}
          />

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-800 transition-colors"
              title={t('story.undo', 'Undo')}
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className="p-1.5 text-slate-400 hover:text-white disabled:opacity-30 rounded hover:bg-slate-800 transition-colors"
              title={t('story.redo', 'Redo')}
            >
              <Redo2 size={16} />
            </button>

            {/* Smart AI Actions Dropdown — portal+fixed so CodeMirror cannot cover it */}
            <div className="relative">
              <button
                ref={aiMenuBtnRef}
                type="button"
                aria-expanded={showAiMenu}
                aria-haspopup="menu"
                onClick={() => setShowAiMenu((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs font-medium transition-colors ${
                  showAiMenu
                    ? 'bg-indigo-600/40 text-indigo-200 border-indigo-400/50'
                    : 'bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border-indigo-500/30'
                }`}
                title={t('story.smart_ai_tools', '智能创作工具')}
              >
                <Sparkles size={14} className="text-indigo-400" />
                <span className="hidden md:inline">{t('story.smart_ai_tools', '智能创作')}</span>
                <ChevronDown
                  size={13}
                  className={`text-indigo-400 transition-transform duration-150 ${
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
                    className="w-64 overflow-y-auto overscroll-contain bg-slate-900 border border-slate-700 rounded-xl shadow-2xl shadow-black/50 py-1.5 text-xs custom-scrollbar animate-in fade-in zoom-in-95 duration-150 origin-top-right"
                  >
                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                      {t('story.ai_extraction_analysis', '分析与抽取')}
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_extract_chars',
                            '请提取并分析当前章节出现的所有角色与性格特征'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Users size={14} className="text-indigo-400 flex-shrink-0" />
                      <span>{t('story.analyze_characters', '提取本章角色')}</span>
                    </button>
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
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Sparkles size={14} className="text-sky-400 flex-shrink-0" />
                      <span>{t('story.analyze_impact', '剧情深度分析')}</span>
                    </button>

                    <div className="h-px bg-slate-800 my-1" />

                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
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
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Film size={14} className="text-purple-400 flex-shrink-0" />
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
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <Wand2 size={14} className="text-amber-400 flex-shrink-0" />
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
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <RefreshCw size={14} className="text-rose-400 flex-shrink-0" />
                      <span>{t('story.skill_reversal', '设计情节反转')}</span>
                    </button>

                    <div className="h-px bg-slate-800 my-1" />

                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold text-slate-500 tracking-wider">
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
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <ShieldAlert size={14} className="text-amber-400 flex-shrink-0" />
                      <span>{t('story.consistency_btn', '全书逻辑体检')}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        handleTriggerAgentAction(
                          t(
                            'agent.prompt_impact',
                            '本章已定稿，请提取角色（含性格特征）、世界观术语并更新到角色库与设定库'
                          )
                        )
                      }
                      className="w-full px-3 py-2 text-left text-slate-300 hover:bg-indigo-600/20 hover:text-indigo-200 flex items-center gap-2"
                    >
                      <BookOpen size={14} className="text-emerald-400 flex-shrink-0" />
                      <span>{t('story.impact_btn', '定稿：更新世界观')}</span>
                    </button>
                  </div>,
                  document.body
                )}
            </div>

            {/* Soft link to Director (generate shots only in director workspace) */}
            <button
              type="button"
              onClick={handleOpenDirector}
              disabled={!projectId}
              className="p-1.5 text-slate-500 hover:text-slate-300 rounded-lg hover:bg-slate-800/80 transition-colors disabled:opacity-30"
              title={t('story.open_director', '打开导演分镜工作台')}
            >
              <Clapperboard size={16} />
            </button>

            {/* Open Global Agent OS */}
            <button
              type="button"
              onClick={() => agentCtx?.setOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-indigo-400 hover:text-indigo-300 bg-indigo-950/40 hover:bg-indigo-950/60 border border-indigo-800/40 rounded-lg text-xs font-medium transition-colors"
              title={t('agent.open_panel', '打开 Agent OS')}
            >
              <Bot size={15} />
              <span className="hidden sm:inline">{t('agent.fab_label', 'Agent OS')}</span>
            </button>

            {/* Save Button */}
            <button 
              onClick={handleSave}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs sm:text-sm font-medium transition-colors shadow-md shadow-indigo-600/20"
            >
              <Save size={14} /> 
              <span>{t('story.save')}</span>
            </button>
          </div>
        </div>

        {/* Outline / Summary Bar */}
        {selectedChapter && (
          <div className="px-4 lg:px-6 py-2 border-b border-slate-800 bg-slate-950/80">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                {t('story.chapter_summary', '本章剧情大纲 / 梗概 (Summary)')}
              </label>
            </div>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={2}
              placeholder={t('story.summary_placeholder', '核心冲突、情节走向、结尾悬念…')}
              className="mt-1 w-full bg-slate-900/90 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-indigo-500 resize-none transition-colors"
            />
          </div>
        )}
        
        {/* Editor Body */}
        <div className="flex-1 relative group/editor overflow-hidden flex flex-col">
          {selectedChapter ? (
            <SimpleMDE
              key={selectedChapter.id}
              value={content}
              onChange={(val) => setContent(val)}
              options={editorOptions}
              className="h-full custom-simplemde"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
              {t('story.no_chapters')}
            </div>
          )}
          
          {/* AI Floating Quick Action Toolbar */}
          <div className="absolute bottom-6 right-8 flex items-center gap-3 z-10">
            <button
              onClick={handleAIDraft}
              disabled={aiLoading}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2.5 rounded-full shadow-xl shadow-indigo-600/40 transition-transform hover:scale-105 disabled:opacity-50 flex items-center gap-2 text-xs font-medium"
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