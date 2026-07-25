import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, X, User, Edit2, Trash2, Sparkles, Image as ImageIcon, CheckCircle, RefreshCw, Wand2 } from 'lucide-react';
import { api } from '../services/api';
import { Character } from '../types';
import { API_BASE_URL, CHARACTER_ROLES } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';

const formatImageUrl = (url?: string | null) => {
  if (!url) return '';
  if (url.startsWith('/static')) {
    return `${API_BASE_URL.replace('/api', '')}${url}`;
  }
  return url;
};

export const CharacterManager: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState<Partial<Character>>({});
  
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

  // Turnaround Sheet Modal State
  const [sheetModalChar, setSheetModalChar] = useState<Character | null>(null);
  const [modelType, setModelType] = useState<'pony' | 'flux'>('pony');
  const [genType, setGenType] = useState<'turnaround' | 'portrait'>('turnaround');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (projectId) loadCharacters();
  }, [projectId]);

  const loadCharacters = async () => {
    if (!projectId) return;
    try {
      const data = await api.getCharacters(Number(projectId));
      if (Array.isArray(data)) setCharacters(data);
    } catch (e) {
      console.error(e);
      showToast("Failed to load characters", 'error');
    }
  };

  const openModal = (char?: Character) => {
    if (char) {
      setEditingChar({ ...char });
    } else {
      setEditingChar({
        project_id: Number(projectId),
        name: '',
        role: 'protagonist',
        description: '',
        visual_tags: {}
      });
    }
    setTagKey('');
    setTagValue('');
    setShowModal(true);
  };

  const handleAddTag = () => {
    if (!tagKey || !tagValue) return;
    setEditingChar(prev => ({
      ...prev,
      visual_tags: { ...prev.visual_tags, [tagKey]: tagValue }
    }));
    setTagKey('');
    setTagValue('');
  };

  const removeTag = (key: string) => {
    const newTags = { ...editingChar.visual_tags };
    delete newTags[key];
    setEditingChar({ ...editingChar, visual_tags: newTags });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingChar.id) {
        await api.updateCharacter(editingChar.id, editingChar);
      } else {
        await api.createCharacter(editingChar);
      }
      setShowModal(false);
      loadCharacters();
      showToast("Character saved", 'success');
    } catch (e) {
      showToast("Failed to save character", 'error');
    }
  };
  
  const handleDelete = async (id: number) => {
    if(!confirm(t('characters.delete_confirm'))) return;
    try {
        await api.deleteCharacter(id);
        loadCharacters();
        showToast("Character deleted", 'success');
    } catch (e) {
        showToast("Failed to delete character", 'error');
    }
  };

  // Open Turnaround Sheet Generator
  const openSheetModal = async (char: Character) => {
    setSheetModalChar(char);
    const mType = char.model_type || 'pony';
    setModelType(mType);

    // Flow sequence: Default to 'portrait' if no image exists yet, otherwise 'turnaround'
    const initialGenType = (!char.avatar_url && !char.turnaround_url) ? 'portrait' : 'turnaround';
    setGenType(initialGenType);
    setGeneratedImageUrl(null);

    try {
      const res = await api.buildCharacterPrompt(char.id, mType, initialGenType, char.description);
      setPrompt(res.prompt);
      setNegativePrompt(res.negative_prompt);
    } catch (e) {
      setPrompt(`score_9, score_8_up, character sheet, turnaround, multi-view, full body, ${char.description || ''}`);
      setNegativePrompt(`score_4, score_3, bad anatomy, low quality`);
    }
  };

  const handleRebuildPrompt = async (selectedModel: 'pony' | 'flux', selectedGen: 'turnaround' | 'portrait') => {
    if (!sheetModalChar) return;
    try {
      const res = await api.buildCharacterPrompt(sheetModalChar.id, selectedModel, selectedGen, sheetModalChar.description);
      setPrompt(res.prompt);
      setNegativePrompt(res.negative_prompt);
    } catch (e) {
      showToast("Failed to generate prompt", 'error');
    }
  };

  const handleGenerateSheetImage = async () => {
    if (!sheetModalChar || !prompt) return;
    setIsGenerating(true);
    setGeneratedImageUrl(null);

    try {
      // Trigger generation via asset API
      const payload = {
        prompt: prompt,
        negative_prompt: negativePrompt,
        model_type: modelType,
        mode: 'standard'
      };
      const res = await api.generateAsset(payload, 999990 + sheetModalChar.id);
      const taskId = res.task_id;

      // Subscribe to SSE or poll for completion
      const eventSource = new EventSource(`${api['request'] ? '' : 'http://127.0.0.1:8000'}/api/assets/stream/${taskId}`);
      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'complete' || data.status === 'completed') {
            if (data.image_url) {
              setGeneratedImageUrl(data.image_url);
              showToast("Image generated successfully", 'success');
            }
            setIsGenerating(false);
            eventSource.close();
          } else if (data.status === 'failed') {
            showToast(data.error || "Generation failed", 'error');
            setIsGenerating(false);
            eventSource.close();
          }
        } catch (err) {
          console.error(err);
        }
      };

      eventSource.onerror = () => {
        setIsGenerating(false);
        eventSource.close();
      };
    } catch (e) {
      console.error(e);
      showToast("Generation failed", 'error');
      setIsGenerating(false);
    }
  };

  const saveAssetToCharacter = async (assetType: 'turnaround' | 'avatar') => {
    if (!sheetModalChar || !generatedImageUrl) return;
    try {
      const updatePayload: any = {
        model_type: modelType
      };
      if (assetType === 'turnaround') {
        updatePayload.turnaround_url = generatedImageUrl;
      } else {
        updatePayload.avatar_url = generatedImageUrl;
      }

      await api.updateCharacter(sheetModalChar.id, updatePayload);
      showToast("Asset saved to character profile!", 'success');
      loadCharacters();
      setSheetModalChar(null);
    } catch (e) {
      showToast("Failed to save asset", 'error');
    }
  };

  const handleCropFace = async (charId: number) => {
    try {
      await api.cropCharacterFace(charId);
      showToast(t('characters.crop_face') + " Success!", 'success');
      loadCharacters();
    } catch (e) {
      showToast("Failed to crop face ref", 'error');
    }
  };

  const handleTrainLora = async (charId: number) => {
    try {
      await api.trainCharacterLora(charId);
      showToast("Character LoRA Initialized & Ready!", 'success');
      loadCharacters();
    } catch (e) {
      showToast("Failed to initialize LoRA", 'error');
    }
  };

  return (
    <div className="flex-1 bg-slate-950 p-4 sm:p-8 overflow-y-auto h-full">
      <div className="flex justify-between items-center mb-6 sm:mb-8">
        <h2 className="text-xl sm:text-2xl font-bold text-white">{t('characters.title')}</h2>
        <button
          onClick={() => openModal()}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm sm:text-base font-medium"
        >
          <Plus size={18} /> {t('characters.add_btn')}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {characters.map(char => {
          const isLoraReady = char.visual_tags?.assets?.lora_ready || false;
          return (
          <div key={char.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 hover:border-indigo-500/30 transition-all flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    {char.avatar_url || char.turnaround_url ? (
                      <img
                        src={formatImageUrl(char.avatar_url || char.turnaround_url)}
                        alt={char.name}
                        className="w-14 h-14 rounded-full object-cover border-2 border-indigo-500/50 shadow-md"
                      />
                    ) : (
                      <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-slate-400 flex-shrink-0">
                        <User size={24} />
                      </div>
                    )}
                    {char.face_url && (
                      <img
                        src={formatImageUrl(char.face_url)}
                        alt="Face Ref"
                        title="Face Reference"
                        className="w-6 h-6 rounded-full object-cover border border-amber-400 absolute -bottom-1 -right-1 shadow"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-bold text-lg text-slate-100 truncate flex items-center gap-1.5 flex-wrap">
                      {char.name}
                      {char.model_type && (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded font-mono bg-indigo-950 text-indigo-300 border border-indigo-800/50">
                          {char.model_type}
                        </span>
                      )}
                      {isLoraReady && (
                        <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded font-mono bg-emerald-950 text-emerald-300 border border-emerald-800/50">
                          LoRA
                        </span>
                      )}
                    </h3>
                    <span className="text-xs uppercase tracking-wide text-indigo-400 font-semibold">
                      {t(`roles.${char.role}`) || char.role}
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                   <button onClick={() => openModal(char)} className="p-2 hover:bg-slate-800 rounded text-slate-400"><Edit2 size={14}/></button>
                   <button onClick={() => handleDelete(char.id)} className="p-2 hover:bg-slate-800 rounded text-red-400"><Trash2 size={14}/></button>
                </div>
              </div>
              
              <p className="text-slate-400 text-sm mb-4 line-clamp-3 h-14">{char.description}</p>

              {/* Character Sheet / Preview Images */}
              {char.turnaround_url && (
                <div className="mb-4 rounded-lg overflow-hidden border border-slate-800 relative group bg-black/40">
                  <img src={formatImageUrl(char.turnaround_url)} alt="Turnaround Sheet" className="w-full h-32 object-cover" />
                  <div className="absolute inset-0 bg-slate-950/60 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center gap-2">
                    <span className="text-xs text-indigo-300 font-medium flex items-center gap-1">
                      <ImageIcon size={14} /> {t('characters.turnaround_sheet')}
                    </span>
                  </div>
                </div>
              )}
              
              <div className="border-t border-slate-800 pt-3">
                <h4 className="text-xs font-semibold text-slate-500 mb-2">{t('characters.visual_tags')}</h4>
                <div className="flex flex-wrap gap-2 max-h-20 overflow-y-auto">
                  {(() => {
                    const tags = char.visual_tags?.base_model?.tags || char.visual_tags || {};
                    return Object.entries(tags).map(([k, v]) => {
                      if (typeof v === 'object' && v !== null) return null; // Skip complex objects in summary
                      return (
                        <span key={k} className="px-2 py-1 bg-slate-800 rounded text-xs text-slate-300 border border-slate-700">
                          <span className="text-indigo-400">{k}:</span> {String(v)}
                        </span>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>

            {/* Action Bar for Turnaround, Face Crop, and LoRA */}
            <div className="mt-4 pt-3 border-t border-slate-800/60 flex flex-col gap-2">
              <button
                onClick={() => openSheetModal(char)}
                className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-indigo-600 text-slate-200 hover:text-white px-3 py-2 rounded-lg text-xs font-medium transition-all"
              >
                <Sparkles size={14} className="text-indigo-400" />
                {t('characters.generate_sheet')}
              </button>

              <div className="flex gap-2">
                <button
                  onClick={() => handleCropFace(char.id)}
                  disabled={!char.turnaround_url && !char.avatar_url}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-amber-900/40 text-slate-300 hover:text-amber-200 border border-slate-800 hover:border-amber-700/50 disabled:opacity-40 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                >
                  {t('characters.crop_face')}
                </button>
                <button
                  onClick={() => handleTrainLora(char.id)}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-emerald-900/40 text-slate-300 hover:text-emerald-200 border border-slate-800 hover:border-emerald-700/50 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all"
                >
                  {t('characters.train_lora')}
                </button>
              </div>
            </div>
          </div>
        );
        })}
      </div>

      {/* Edit Character Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto flex flex-col">
            <div className="p-4 sm:p-6 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
              <h3 className="text-lg sm:text-xl font-bold text-white">{editingChar.id ? t('characters.edit_title') : t('characters.new_title')}</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white"><X size={24}/></button>
            </div>
            
            <form onSubmit={handleSave} className="p-4 sm:p-6 space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                   <label className="block text-sm text-slate-400 mb-1">{t('characters.name')}</label>
                   <input 
                      required
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white text-sm sm:text-base" 
                      value={editingChar.name || ''} 
                      onChange={e => setEditingChar({...editingChar, name: e.target.value})} 
                   />
                </div>
                <div>
                   <label className="block text-sm text-slate-400 mb-1">{t('characters.role')}</label>
                   <select 
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white text-sm sm:text-base"
                      value={editingChar.role || 'protagonist'}
                      onChange={e => setEditingChar({...editingChar, role: e.target.value})}
                   >
                     {CHARACTER_ROLES.map(r => <option key={r.value} value={r.value}>{t(`roles.${r.value}`) || r.label}</option>)}
                   </select>
                </div>
              </div>
              
              <div>
                 <label className="block text-sm text-slate-400 mb-1">{t('characters.desc')}</label>
                 <textarea 
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white h-24 text-sm sm:text-base"
                    value={editingChar.description || ''}
                    onChange={e => setEditingChar({...editingChar, description: e.target.value})}
                 />
              </div>

              {/* Visual Tags Editor */}
              <div className="bg-slate-950 rounded-lg p-4 border border-slate-800">
                <label className="block text-sm font-semibold text-indigo-400 mb-3">{t('characters.visual_tags_sub')}</label>
                <div className="flex flex-col sm:flex-row gap-2 mb-3">
                  <input placeholder={t('characters.key_placeholder')} className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tagKey} onChange={e => setTagKey(e.target.value)} />
                  <input placeholder={t('characters.val_placeholder')} className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white" value={tagValue} onChange={e => setTagValue(e.target.value)} />
                  <button type="button" onClick={handleAddTag} className="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded text-white self-end sm:self-auto flex items-center justify-center gap-1"><Plus size={16} /><span className="sm:hidden text-xs">Add Tag</span></button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(editingChar.visual_tags || {}).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-2 px-3 py-1 bg-indigo-900/30 border border-indigo-500/30 rounded-full text-sm">
                      <span className="text-indigo-300 font-mono">{k}:</span>
                      <span className="text-slate-200 truncate max-w-[200px]">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                      <button type="button" onClick={() => removeTag(k)} className="hover:text-red-400"><X size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end pt-4">
                <button type="submit" className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium">
                  {t('characters.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Turnaround Sheet / Portrait Generator Modal */}
      {sheetModalChar && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto flex flex-col">
            <div className="p-4 sm:p-6 border-b border-slate-800 flex justify-between items-center sticky top-0 bg-slate-900 z-10">
              <div className="flex items-center gap-3">
                <Sparkles className="text-indigo-400" size={22} />
                <h3 className="text-lg sm:text-xl font-bold text-white">
                  {t('characters.generate_sheet')} - {sheetModalChar.name}
                </h3>
              </div>
              <button onClick={() => setSheetModalChar(null)} className="text-slate-400 hover:text-white"><X size={24}/></button>
            </div>

            <div className="p-4 sm:p-6 space-y-6">
              {/* Model & Preset Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <label className="block text-xs uppercase font-semibold tracking-wider text-slate-400 mb-2">
                    {t('characters.model_preset')}
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setModelType('pony'); handleRebuildPrompt('pony', genType); }}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                        modelType === 'pony'
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Pony XL (SDXL)
                    </button>
                    <button
                      type="button"
                      onClick={() => { setModelType('flux'); handleRebuildPrompt('flux', genType); }}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                        modelType === 'flux'
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      FLUX.1-dev (GGUF)
                    </button>
                  </div>
                </div>

                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <label className="block text-xs uppercase font-semibold tracking-wider text-slate-400 mb-2">
                    {t('characters.gen_type')}
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => { setGenType('turnaround'); handleRebuildPrompt(modelType, 'turnaround'); }}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                        genType === 'turnaround'
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('characters.turnaround_sheet')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setGenType('portrait'); handleRebuildPrompt(modelType, 'portrait'); }}
                      className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold border transition-all ${
                        genType === 'portrait'
                          ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {t('characters.portrait')}
                    </button>
                  </div>
                </div>
              </div>

              {/* Prompt Box */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-sm text-slate-300 font-medium">{t('characters.prompt')}</label>
                  <button
                    type="button"
                    onClick={() => handleRebuildPrompt(modelType, genType)}
                    className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    <Wand2 size={12} /> Re-Generate Prompt
                  </button>
                </div>
                <textarea
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-white text-xs sm:text-sm font-mono h-24 focus:border-indigo-500 focus:outline-none"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                />
              </div>

              {/* Negative Prompt Box */}
              <div>
                <label className="block text-sm text-slate-400 mb-1">{t('characters.negative_prompt')}</label>
                <input
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-slate-300 text-xs font-mono focus:border-indigo-500 focus:outline-none"
                  value={negativePrompt}
                  onChange={e => setNegativePrompt(e.target.value)}
                />
              </div>

              {/* Generation Execution & Preview */}
              <div className="border-t border-slate-800 pt-4 flex flex-col items-center">
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={handleGenerateSheetImage}
                  className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
                >
                  {isGenerating ? (
                    <>
                      <RefreshCw size={18} className="animate-spin" />
                      {t('director.status_generating')}...
                    </>
                  ) : (
                    <>
                      <Sparkles size={18} />
                      {t('characters.generate_now')}
                    </>
                  )}
                </button>

                {/* Image Output Display */}
                {generatedImageUrl && (
                  <div className="mt-6 w-full flex flex-col items-center space-y-4">
                    <div className="relative rounded-xl overflow-hidden border border-indigo-500/40 bg-black/60 max-h-80 shadow-2xl">
                      <img src={formatImageUrl(generatedImageUrl)} alt="Generated Asset" className="max-h-80 object-contain" />
                    </div>

                    <div className="flex gap-4">
                      <button
                        type="button"
                        onClick={() => saveAssetToCharacter('turnaround')}
                        className="bg-indigo-900/60 hover:bg-indigo-600 text-indigo-100 hover:text-white px-4 py-2 rounded-lg text-xs font-semibold border border-indigo-500/40 flex items-center gap-1.5 transition-all"
                      >
                        <CheckCircle size={14} /> {t('characters.save_as_turnaround')}
                      </button>

                      <button
                        type="button"
                        onClick={() => saveAssetToCharacter('avatar')}
                        className="bg-emerald-900/60 hover:bg-emerald-600 text-emerald-100 hover:text-white px-4 py-2 rounded-lg text-xs font-semibold border border-emerald-500/40 flex items-center gap-1.5 transition-all"
                      >
                        <CheckCircle size={14} /> {t('characters.save_as_avatar')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};