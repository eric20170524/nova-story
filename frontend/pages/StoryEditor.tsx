import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Wand2, RefreshCw, Plus, FileText, PanelRight, X, Trash2, Film, Clapperboard, ArrowUp, ArrowDown, Users, Sparkles, BookOpen, Grid } from 'lucide-react';
import SimpleMDE from 'react-simplemde-editor';
import { api } from '../services/api';
import { Chapter } from '../types';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';

export const StoryEditor: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [content, setContent] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  
  // Cinematic Grid State
  const [gridPrompt, setGridPrompt] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(false);
  const [showGridModal, setShowGridModal] = useState(false);
  
  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [extractedCharacters, setExtractedCharacters] = useState<any[]>([]);
  const [analysisResult, setAnalysisResult] = useState<{ new_entities: string[], updates: string[] } | null>(null);
  
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [activeTab, setActiveTab] = useState<'characters' | 'analysis'>('characters');

  useEffect(() => {
    console.log(`[StoryEditor] Mounted. ProjectId: ${projectId}`);
    if (projectId) loadChapters();
  }, [projectId]);

  useEffect(() => {
    if (selectedChapter) {
      console.log(`[StoryEditor] Chapter selected: ${selectedChapter.id} - ${selectedChapter.title}`);
      setContent(selectedChapter.content || '');
      setExtractedCharacters([]); // Reset analysis when chapter changes
      setAnalysisResult(null);
      
      // Context Sync: Update local storage so Director Mode knows which chapter is active
      if (projectId) {
          localStorage.setItem(`director_project_${projectId}_chapter`, selectedChapter.id);
      }
    } else {
      console.log(`[StoryEditor] No chapter selected.`);
      setContent('');
    }
  }, [selectedChapter, projectId]);

  const loadChapters = async () => {
    if (!projectId) {
      console.warn("[StoryEditor] loadChapters called without projectId");
      return;
    }
    console.log(`[StoryEditor] Loading chapters for project ${projectId}...`);
    try {
      const data = await api.getChapters(Number(projectId));
      console.log(`[StoryEditor] Chapters loaded:`, data);
      if (Array.isArray(data) && data.length > 0) {
        const sorted = data.sort((a, b) => a.index - b.index);
        setChapters(sorted);
        
        // Try to recover last selected chapter from localStorage, otherwise first
        const savedChapterId = localStorage.getItem(`director_project_${projectId}_chapter`);
        const targetChapter = sorted.find(c => c.id === savedChapterId) || sorted[0];
        
        if (!selectedChapter || selectedChapter.id !== targetChapter.id) {
             setSelectedChapter(targetChapter);
        }
      } else {
        console.log(`[StoryEditor] No chapters found for project ${projectId}.`);
        setChapters([]);
      }
    } catch (err) {
      console.error("[StoryEditor] Could not load chapters", err);
      showToast("Failed to load chapters", 'error');
    }
  };

  const handleCreateChapter = async () => {
    if (!projectId) return;
    const newTitle = `Chapter ${chapters.length + 1}`;
    try {
      const newChapter = await api.createChapter({
        id: crypto.randomUUID(), 
        project_id: Number(projectId),
        title: newTitle,
        index: chapters.length,
        content: ''
      });
      setChapters([...chapters, newChapter]);
      setSelectedChapter(newChapter);
      showToast("Chapter created", 'success');
    } catch (e) {
      console.error("[StoryEditor] Create chapter failed", e);
      showToast("Failed to create chapter", 'error');
    }
  };

  const handleDeleteChapter = async (e: React.MouseEvent, chapterId: string) => {
      e.stopPropagation(); // Prevent selection
      if (!confirm("Are you sure you want to delete this chapter? This action cannot be undone.")) return;
      
      try {
          await api.deleteChapter(chapterId);
          const newChapters = chapters.filter(c => c.id !== chapterId);
          setChapters(newChapters);
          
          if (selectedChapter?.id === chapterId) {
              setSelectedChapter(newChapters.length > 0 ? newChapters[0] : null);
          }
          showToast("Chapter deleted", 'success');
      } catch (e) {
          console.error("Delete failed", e);
          showToast("Failed to delete chapter.", 'error');
      }
  };

  const handleMoveChapter = async (e: React.MouseEvent, chapter: Chapter, direction: 'up' | 'down') => {
      e.stopPropagation();
      const currentIndex = chapters.findIndex(c => c.id === chapter.id);
      if (currentIndex === -1) return;
      
      const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      
      // Bounds check
      if (newIndex < 0 || newIndex >= chapters.length) return;
      
      const targetIndex = newIndex; 
      
      // Optimistic UI update
      const newChapters = [...chapters];
      const [movedChapter] = newChapters.splice(currentIndex, 1);
      newChapters.splice(targetIndex, 0, movedChapter);
      
      // Re-assign local indices for display
      const updatedChapters = newChapters.map((c, i) => ({ ...c, index: i }));
      setChapters(updatedChapters);

      try {
          await api.moveChapter(chapter.id, targetIndex);
      } catch (e) {
          console.error("Move failed", e);
          showToast("Failed to move chapter", 'error');
          loadChapters();
      }
  };

  const handleSave = async () => {
    if (!selectedChapter) return;
    console.log(`[StoryEditor] Saving chapter ${selectedChapter.id}...`);
    try {
      await api.updateChapter(selectedChapter.id, {
        ...selectedChapter,
        content: content
      });
      console.log(`[StoryEditor] Chapter saved.`);
      setChapters(chapters.map(c => c.id === selectedChapter.id ? { ...c, content } : c));
      showToast("Saved", 'success');
    } catch (e) {
      console.error("[StoryEditor] Save failed", e);
      showToast("Failed to save", 'error');
    }
  };

  const handleAIDraft = async () => {
    setAiLoading(true);
    try {
      const prompt = "Continue the story naturally from the current text.";
      const res = await api.draftText(content, prompt);
      if (res && res.content) {
        setContent(prev => prev + "\n" + res.content);
        showToast(t('story.ai_draft_success'), 'success');
      }
    } catch (e) {
      showToast(t('story.ai_draft_fail'), 'error');
      console.error(e);
    } finally {
      setAiLoading(false);
    }
  };

  const handleGenerateGrid = async () => {
    if (!content.trim()) return;
    setGridLoading(true);
    try {
        const res = await api.generateStoryboardGrid(content);
        if (res && res.prompt) {
            setGridPrompt(res.prompt);
            setShowGridModal(true);
            showToast(t('story.grid_prompt_success'), 'success');
        } else {
            showToast(t('story.grid_prompt_fail'), 'error');
        }
    } catch (e) {
        console.error(e);
        showToast(t('story.grid_prompt_fail'), 'error');
    } finally {
        setGridLoading(false);
    }
  };

  const handleGenerateTimeline = async () => {
      if (!selectedChapter) return;
      
      await handleSave();
      
      setBreakdownLoading(true);
      try {
          await api.generateTimeline(selectedChapter.id);
          showToast("Timeline generated. Switching to Director Mode...", 'success');
          setTimeout(() => navigate(`/project/${projectId}/director`), 1000);
      } catch (e) {
          console.error(e);
          showToast(t('director.error_timeline'), 'error');
      } finally {
          setBreakdownLoading(false);
      }
  };

  const handleAnalyzeCharacters = async () => {
    if (!selectedChapter) return;
    setIsAnalyzing(true);
    try {
      const res = await api.extractCharacters(selectedChapter.id);
      setExtractedCharacters(res);
      showToast(t('story.analysis_complete'), 'success');
    } catch (e) {
      console.error(e);
      showToast("Analysis failed", 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDeepAnalysis = async () => {
    if (!selectedChapter || !content.trim()) return;
    setIsAnalyzing(true);
    try {
        const res = await api.analyzeText(content);
        setAnalysisResult(res);
        showToast("Analysis complete", 'success');
    } catch (e) {
        console.error(e);
        showToast("Analysis failed", 'error');
    } finally {
        setIsAnalyzing(false);
    }
  };

  // Editor Options Configuration
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
      <div className="w-16 lg:w-64 bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0 transition-all">
        <div className="p-4 border-b border-slate-800 flex justify-between items-center h-14">
          <h3 className="font-semibold text-slate-300 hidden lg:block">{t('story.chapters')}</h3>
          <button onClick={handleCreateChapter} className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white mx-auto lg:mx-0">
            <Plus size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {chapters.map((chapter, index) => (
            <div
              key={chapter.id}
              onClick={() => setSelectedChapter(chapter)}
              className={`group flex items-center justify-between px-3 py-2 rounded-md cursor-pointer text-sm transition-colors ${selectedChapter?.id === chapter.id 
                  ? 'bg-indigo-600/20 text-indigo-300' 
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
              }`}
              title={chapter.title}
            >
              <div className="flex items-center gap-2 overflow-hidden flex-1">
                  <FileText size={18} className="flex-shrink-0" />
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

      {/* Editor Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 border-b border-slate-800 flex items-center justify-between px-3 sm:px-4 lg:px-6 bg-slate-925 gap-2">
          <input
            type="text"
            className="bg-transparent border-none text-white font-medium focus:ring-0 flex-1 min-w-0 text-sm sm:text-base truncate"
            value={selectedChapter?.title || ''}
            onChange={(e) => selectedChapter && setSelectedChapter({...selectedChapter, title: e.target.value})}
            placeholder={t('story.chapter_title_placeholder')}
          />
          <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <button 
              onClick={() => navigate(`/project/${projectId}/director`)}
              className="hidden md:flex items-center gap-1 px-3 py-1.5 text-slate-400 hover:text-indigo-400 text-sm transition-colors mr-1"
              title="Go to Director Mode"
            >
               <Clapperboard size={16} />
               <span>To Storyboard</span>
            </button>

            <button 
              onClick={handleSave}
              className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs sm:text-sm transition-colors"
            >
              <Save size={14} /> 
              <span className="hidden sm:inline">{t('story.save')}</span>
            </button>
            
            <button 
              onClick={() => setShowRightPanel(!showRightPanel)}
              className="lg:hidden p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg"
            >
               <PanelRight size={18} />
            </button>
          </div>
        </div>
        
        <div className="flex-1 relative group/editor overflow-hidden flex flex-col">
          {selectedChapter ? (
              <SimpleMDE
                key={selectedChapter.id} // Re-render SimpleMDE when chapter changes to ensure content sync
                value={content}
                onChange={(val) => setContent(val)}
                options={editorOptions}
                className="h-full"
              />
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
                {t('story.no_chapters')}
            </div>
          )}
          
          {/* AI Floating Toolbar */}
          <div className="absolute bottom-4 right-4 lg:bottom-8 lg:right-8 flex flex-col gap-3 transition-opacity opacity-70 hover:opacity-100 z-10">
             <button
              onClick={handleAIDraft}
              disabled={aiLoading}
              className="bg-indigo-600 hover:bg-indigo-500 text-white p-2.5 sm:p-3 rounded-full shadow-lg shadow-indigo-600/30 transition-transform hover:scale-105 disabled:opacity-50 flex items-center justify-center gap-2"
              title={t('story.ai_continue')}
            >
              {aiLoading ? <RefreshCw className="animate-spin" size={18} /> : <Wand2 size={18} />}
            </button>
          </div>
        </div>
      </div>
      
      {/* Right Tools Pane */}
      <div className={`
        fixed inset-y-0 right-0 w-80 bg-slate-900 border-l border-slate-800 shadow-2xl z-50 transform transition-transform duration-300 flex flex-col
        lg:static lg:translate-x-0 lg:shadow-none lg:w-80 lg:block
        ${showRightPanel ? 'translate-x-0' : 'translate-x-full'}
      `}>
         {/* ... Right panel content same as before ... */}
         <div className="p-4 border-b border-slate-800 flex justify-between items-center lg:hidden">
            <h4 className="font-semibold text-white">{t('story.assistant_title')}</h4>
            <button onClick={() => setShowRightPanel(false)} className="text-slate-400 hover:text-white">
              <X size={20} />
            </button>
         </div>

         <div className="flex border-b border-slate-800">
            <button
              onClick={() => setActiveTab('characters')}
              className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === 'characters' 
                  ? 'text-indigo-400 border-b-2 border-indigo-500 bg-slate-800/30' 
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Users size={16} />
              <span>{t('story.tab_characters')}</span>
            </button>
            <button
              onClick={() => setActiveTab('analysis')}
              className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                activeTab === 'analysis' 
                  ? 'text-indigo-400 border-b-2 border-indigo-500 bg-slate-800/30' 
                  : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Sparkles size={16} />
              <span>{t('story.tab_analysis')}</span>
            </button>
         </div>

         <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            <div className="bg-slate-800/50 rounded-lg p-3 border border-slate-700 mb-6">
                <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-2">
                    <BookOpen size={12} />
                    {t('story.context_awareness')}
                </h5>
                <p className="text-xs text-slate-400">{t('story.context_desc', { count: chapters.length })}</p>
            </div>

            {activeTab === 'characters' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-left-4 duration-200">
                    <button 
                        onClick={handleAnalyzeCharacters}
                        disabled={isAnalyzing}
                        className="w-full py-2 bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 text-xs rounded transition-colors flex justify-center items-center gap-2"
                    >
                        {isAnalyzing ? <RefreshCw className="animate-spin" size={14} /> : <Users size={14} />}
                        {t('story.analyze_characters')}
                    </button>

                    {extractedCharacters.length > 0 ? (
                        <div className="space-y-3">
                            {extractedCharacters.map((char: any, i) => (
                                <div key={i} className="bg-slate-800/30 p-3 rounded border border-slate-800 hover:border-slate-700 transition-colors">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="font-semibold text-indigo-300 text-sm">{char.name}</span>
                                        <span className="text-[10px] uppercase bg-slate-800 px-1.5 py-0.5 rounded text-slate-500">{char.role}</span>
                                    </div>
                                    <p className="text-xs text-slate-400 line-clamp-2">{char.description}</p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center text-slate-600 text-xs py-8">
                            {t('story.no_chars_extracted')}
                        </div>
                    )}
                </div>
            )}

            {activeTab === 'analysis' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-200">
                    <button 
                        onClick={handleDeepAnalysis}
                        disabled={isAnalyzing}
                        className="w-full py-2 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-300 border border-emerald-500/30 text-xs rounded transition-colors flex justify-center items-center gap-2"
                    >
                        {isAnalyzing ? <RefreshCw className="animate-spin" size={14} /> : <Sparkles size={14} />}
                        {t('story.analyze_impact')}
                    </button>

                    {analysisResult ? (
                        <div className="space-y-6">
                            <div>
                                <h5 className="text-xs font-bold text-slate-500 mb-2 uppercase tracking-wide">{t('story.new_entities')}</h5>
                                {analysisResult.new_entities.length > 0 ? (
                                    <div className="flex flex-wrap gap-2">
                                        {analysisResult.new_entities.map((entity, i) => (
                                            <span key={i} className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300">
                                                {entity}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-xs text-slate-500 italic">{t('story.no_new_entities')}</p>
                                )}
                            </div>

                            <div>
                                <h5 className="text-xs font-bold text-slate-500 mb-2 uppercase tracking-wide">{t('story.plot_progression')}</h5>
                                {analysisResult.updates.length > 0 ? (
                                    <ul className="space-y-2">
                                        {analysisResult.updates.map((update, i) => (
                                            <li key={i} className="text-xs text-slate-300 flex gap-2">
                                                <span className="text-indigo-500 mt-0.5">•</span>
                                                <span>{update}</span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="text-xs text-slate-500 italic">{t('story.no_plot_updates')}</p>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="text-center text-slate-600 text-xs py-8">
                            {t('story.analyze_prompt')}
                        </div>
                    )}
                </div>
            )}
         </div>
      </div>

      {showRightPanel && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setShowRightPanel(false)}
        />
      )}

      {/* Cinematic Grid Modal */}
      {showGridModal && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
                <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900 rounded-t-xl">
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                        <Grid size={20} className="text-purple-400" />
                        {t('story.grid_modal_title')}
                    </h3>
                    <button onClick={() => setShowGridModal(false)} className="text-slate-400 hover:text-white transition-colors">
                        <X size={24} />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 bg-slate-950/50 space-y-4">
                    <div className="bg-purple-950/40 border border-purple-800/60 rounded-lg p-3 text-xs text-purple-300 font-medium">
                        {t('story.grid_tool_notice')}
                    </div>
                    <div className="bg-slate-800 p-6 rounded-lg border border-slate-700 font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed selection:bg-purple-500/30">
                        {gridPrompt}
                    </div>
                </div>
                <div className="p-4 border-t border-slate-800 flex justify-end gap-3 bg-slate-900 rounded-b-xl">
                    <button 
                        onClick={() => setShowGridModal(false)}
                        className="px-4 py-2 text-slate-400 hover:text-white text-sm font-medium transition-colors"
                    >
                        {t('story.close')}
                    </button>
                    <button 
                        onClick={() => {
                            navigator.clipboard.writeText(gridPrompt || "");
                            showToast(t('story.copied'), 'success');
                        }}
                        className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shadow-lg shadow-purple-600/20"
                    >
                        <FileText size={16} />
                        {t('story.copy_prompt')}
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};