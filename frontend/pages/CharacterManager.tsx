import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, X, User, Edit2, Trash2 } from 'lucide-react';
import { api } from '../services/api';
import { Character } from '../types';
import { CHARACTER_ROLES } from '../constants';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';

export const CharacterManager: React.FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingChar, setEditingChar] = useState<Partial<Character>>({});
  
  const [tagKey, setTagKey] = useState('');
  const [tagValue, setTagValue] = useState('');

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
        {characters.map(char => (
          <div key={char.id} className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 hover:border-indigo-500/30 transition-all">
            <div className="flex justify-between items-start mb-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center text-slate-400 flex-shrink-0">
                  <User size={24} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold text-lg text-slate-100 truncate">{char.name}</h3>
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
            
            <div className="border-t border-slate-800 pt-4">
              <h4 className="text-xs font-semibold text-slate-500 mb-2">{t('characters.visual_tags')}</h4>
              <div className="flex flex-wrap gap-2">
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
        ))}
      </div>

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
    </div>
  );
};