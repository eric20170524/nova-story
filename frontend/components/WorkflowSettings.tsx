import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Workflow } from '../types';
import { Workflow as WorkflowIcon, Edit, ToggleLeft, ToggleRight, X, Save } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export const WorkflowSettings: React.FC = () => {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const { t } = useLanguage();
  
  // Edit State
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [jsonContent, setJsonContent] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    loadWorkflows();
  }, []);

  const loadWorkflows = () => {
    api.getWorkflows().then(data => {
      if(Array.isArray(data)) setWorkflows(data);
    }).catch(console.error);
  };

  const handleToggleActive = async (workflow: Workflow) => {
    try {
      const updated = { ...workflow, is_active: !workflow.is_active };
      // Optimistic update
      setWorkflows(prev => prev.map(w => w.id === workflow.id ? updated : w));
      
      await api.updateWorkflow(workflow.id, { is_active: updated.is_active });
    } catch (e) {
      console.error("Failed to toggle workflow", e);
      // Revert on failure
      loadWorkflows();
    }
  };

  const openEditModal = (workflow: Workflow) => {
    setEditingWorkflow(workflow);
    setEditName(workflow.name);
    setEditDesc(workflow.description || "");
    setJsonContent(JSON.stringify(workflow.content, null, 2));
    setJsonError(null);
  };

  const closeEditModal = () => {
    setEditingWorkflow(null);
    setJsonContent("");
  };

  const handleSave = async () => {
    if (!editingWorkflow) return;

    try {
      const parsedContent = JSON.parse(jsonContent);
      
      const updateData = {
        name: editName,
        description: editDesc,
        content: parsedContent
      };

      await api.updateWorkflow(editingWorkflow.id, updateData);
      
      // Refresh list and close
      loadWorkflows();
      closeEditModal();
      // Optional: Show success toast?
    } catch (e) {
      if (e instanceof SyntaxError) {
        setJsonError("Invalid JSON format");
      } else {
        console.error("Failed to save workflow", e);
        setJsonError("Failed to save workflow");
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4">
        {workflows.map(wf => (
          <div key={wf.id} className="bg-slate-900 p-4 sm:p-6 rounded-xl border border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:border-indigo-500/50 transition-colors">
             <div className="flex items-center gap-4 flex-1">
                <div className={`p-3 rounded-lg flex-shrink-0 ${wf.is_active ? 'bg-indigo-900/20 text-indigo-400' : 'bg-slate-800 text-slate-500'}`}>
                   <WorkflowIcon />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold text-white text-base sm:text-lg truncate">{wf.name}</h3>
                  <p className="text-xs sm:text-sm text-slate-400 line-clamp-2">{wf.description}</p>
                </div>
             </div>
             
             <div className="flex items-center gap-4 self-end sm:self-auto">
                {/* Active Toggle */}
                <button 
                  onClick={() => handleToggleActive(wf)}
                  className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                  title={wf.is_active ? "Deactivate" : "Activate"}
                >
                  {wf.is_active ? (
                    <>
                      <span className="text-xs text-green-400">{t('workflow.active')}</span>
                      <ToggleRight className="text-green-500" size={24} />
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-slate-500">{t('workflow.inactive')}</span>
                      <ToggleLeft size={24} />
                    </>
                  )}
                </button>

                {/* Edit Button */}
                <button 
                  onClick={() => openEditModal(wf)}
                  className="p-2 bg-slate-800 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                  title="Edit"
                >
                  <Edit size={18} />
                </button>
             </div>
          </div>
        ))}
        {workflows.length === 0 && <p className="text-slate-500">{t('workflow.no_workflows')}</p>}
      </div>

      {/* Edit Modal */}
      {editingWorkflow && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-slate-900 rounded-xl w-full max-w-4xl h-[90vh] flex flex-col border border-slate-700 shadow-2xl">
            
            {/* Header */}
            <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900 rounded-t-xl">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Edit className="text-indigo-400" size={20} />
                {t('workflow.edit')}: {editingWorkflow.name}
              </h2>
              <button onClick={closeEditModal} className="text-slate-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              
              {/* Meta Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-1">{t('workflow.name')}</label>
                  <input 
                    type="text" 
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-1">{t('workflow.desc')}</label>
                  <input 
                    type="text" 
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* JSON Editor */}
              <div className="flex flex-col h-full min-h-[400px]">
                <label className="block text-sm font-medium text-slate-400 mb-1 flex justify-between">
                  {t('workflow.json_content')}
                  {jsonError && <span className="text-red-400 text-xs font-bold">{jsonError}</span>}
                </label>
                <textarea
                  value={jsonContent}
                  onChange={(e) => {
                    setJsonContent(e.target.value);
                    setJsonError(null); 
                  }}
                  className={`w-full flex-1 bg-slate-950 border ${jsonError ? 'border-red-500' : 'border-slate-800'} rounded p-4 text-sm font-mono text-green-400 focus:outline-none focus:border-indigo-500 resize-none`}
                  spellCheck="false"
                />
              </div>

            </div>

            {/* Footer */}
            <div className="p-6 border-t border-slate-800 flex justify-end gap-4 bg-slate-900 rounded-b-xl">
              <button 
                onClick={closeEditModal}
                className="px-4 py-2 text-slate-400 hover:text-white transition-colors"
              >
                {t('workflow.cancel')}
              </button>
              <button 
                onClick={handleSave}
                className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium flex items-center gap-2 transition-colors"
              >
                <Save size={18} />
                {t('workflow.save')}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
};
