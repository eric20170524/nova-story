import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Workflow } from '../types';
import { Workflow as WorkflowIcon, Edit, ToggleLeft, ToggleRight, X, Save } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

export const WorkflowManager: React.FC = () => {
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
      if (Array.isArray(data)) setWorkflows(data);
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
    } catch (e) {
      if (e instanceof SyntaxError) {
        setJsonError("JSON 格式错误，请检查语法");
      } else {
        console.error("Failed to save workflow", e);
        setJsonError("保存工作流失败");
      }
    }
  };

  return (
    <div className="p-6 sm:p-10 bg-slate-50/50 dark:bg-slate-950 h-full overflow-y-auto custom-scrollbar transition-colors">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <WorkflowIcon className="text-indigo-600 dark:text-indigo-400" />
            <span>{t('workflow.title')}</span>
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">管理 ComfyUI 图像生成管线与自定义节点工作流</p>
        </div>
        
        <div className="grid gap-3.5">
          {workflows.map(wf => (
            <div key={wf.id} className="bg-white dark:bg-slate-900 p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:border-indigo-400 dark:hover:border-indigo-500/50 shadow-sm transition-all">
               <div className="flex items-center gap-3.5 flex-1 min-w-0">
                  <div className={`p-3 rounded-xl flex-shrink-0 ${wf.is_active ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/40' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700'}`}>
                     <WorkflowIcon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-bold text-slate-900 dark:text-white text-base truncate">{wf.name}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5">{wf.description}</p>
                  </div>
               </div>
               
               <div className="flex items-center gap-3 self-end sm:self-auto">
                  {/* Active Toggle */}
                  <button 
                    onClick={() => handleToggleActive(wf)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors shadow-sm"
                    title={wf.is_active ? "停用" : "启用"}
                  >
                    {wf.is_active ? (
                      <>
                        <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">{t('workflow.active')}</span>
                        <ToggleRight className="text-emerald-600 dark:text-emerald-500" size={22} />
                      </>
                    ) : (
                      <>
                        <span className="text-xs text-slate-400 dark:text-slate-500">{t('workflow.inactive')}</span>
                        <ToggleLeft className="text-slate-400 dark:text-slate-600" size={22} />
                      </>
                    )}
                  </button>

                  {/* Edit Button */}
                  <button 
                    onClick={() => openEditModal(wf)}
                    className="p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-white hover:bg-indigo-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition-colors shadow-sm"
                    title="编辑"
                  >
                    <Edit size={16} />
                  </button>
               </div>
            </div>
          ))}
          {workflows.length === 0 && <p className="text-slate-400 dark:text-slate-500 text-center py-6">{t('workflow.no_workflows')}</p>}
        </div>

        {/* Edit Modal */}
        {editingWorkflow && (
          <div className="fixed inset-0 bg-slate-900/40 dark:bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm animate-in fade-in duration-150">
            <div className="bg-white dark:bg-slate-900 rounded-2xl w-full max-w-4xl h-[90vh] flex flex-col border border-slate-200 dark:border-slate-700 shadow-2xl overflow-hidden">
              
              {/* Header */}
              <div className="p-5 border-b border-slate-200 dark:border-slate-800 flex justify-between items-center bg-slate-50 dark:bg-slate-900/90 rounded-t-2xl flex-shrink-0">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Edit className="text-indigo-600 dark:text-indigo-400" size={18} />
                  <span>{t('workflow.edit')}: {editingWorkflow.name}</span>
                </h2>
                <button onClick={closeEditModal} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                  <X size={20} />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-6 space-y-5 min-h-0 custom-scrollbar bg-slate-50/50 dark:bg-slate-950/40">
                {/* Meta Info */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">{t('workflow.name')}</label>
                    <input 
                      type="text" 
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 focus:outline-none shadow-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">{t('workflow.desc')}</label>
                    <input 
                      type="text" 
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      className="w-full bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 focus:outline-none shadow-sm"
                    />
                  </div>
                </div>

                {/* JSON Editor */}
                <div className="flex flex-col h-full min-h-[360px]">
                  <div className="flex justify-between items-center mb-1.5">
                    <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {t('workflow.json_content')}
                    </label>
                    {jsonError && <span className="text-rose-600 dark:text-rose-400 text-xs font-bold">{jsonError}</span>}
                  </div>
                  <textarea
                    value={jsonContent}
                    onChange={(e) => {
                      setJsonContent(e.target.value);
                      setJsonError(null); 
                    }}
                    className={`w-full flex-1 bg-white dark:bg-slate-950 border ${jsonError ? 'border-rose-500' : 'border-slate-200 dark:border-slate-800'} rounded-xl p-4 text-xs font-mono text-slate-800 dark:text-emerald-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 resize-none shadow-sm`}
                    spellCheck="false"
                  />
                </div>
              </div>

              {/* Footer */}
              <div className="p-4 border-t border-slate-200 dark:border-slate-800 flex justify-end gap-3 bg-slate-50 dark:bg-slate-900 rounded-b-2xl flex-shrink-0">
                <button 
                  onClick={closeEditModal}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                  {t('workflow.cancel')}
                </button>
                <button 
                  onClick={handleSave}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 transition-all"
                >
                  <Save size={15} />
                  <span>{t('workflow.save')}</span>
                </button>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
};
