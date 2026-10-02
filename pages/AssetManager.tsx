import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, RefreshCw, Sparkles, Trash2, Pencil, X } from 'lucide-react';
import { CharacterManager } from './CharacterManager';
import { api } from '../services/api';
import { useToast } from '../ToastContext';
import { resolveMediaUrl, useImagePreview } from '../components/ImageLightbox';

type Asset = { id: number; kind: 'location' | 'prop'; name: string; description: string; visual_prompt: string; image_url?: string; status: string; revision: number; task_id?: string };
export const AssetManager: React.FC = () => {
  const { id } = useParams();
  const projectId = Number(id);
  const [tab, setTab] = useState<'character' | 'location' | 'prop'>('character');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [chapters, setChapters] = useState<any[]>([]);
  const [chapterId, setChapterId] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Partial<Asset> | null>(null);
  const { showToast } = useToast();
  const { openPreview, lightbox } = useImagePreview();
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const reload = async () => {
    const requestedProject = projectId;
    const [rows, cs] = await Promise.all([api.getLibraryAssets(projectId), api.getChapters(projectId)]);
    if (currentProject.current !== requestedProject) return;
    setAssets(rows); setChapters(cs);
    setChapterId(prev => cs.some(c => c.id === prev) ? prev : cs[0]?.id || '');
  };
  useEffect(() => { void reload().catch(e => showToast(e.message, 'error')); }, [projectId]);
  useEffect(() => {
    if (!assets.some(a => a.status === 'generating')) return;
    const timer = window.setInterval(() => { void reload().catch(e => showToast(e.message, 'error')); }, 4000);
    return () => window.clearInterval(timer);
  }, [projectId, assets.some(a => a.status === 'generating')]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); await reload(); } catch (e: any) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const selectedKind = tab === 'prop' ? 'prop' : 'location';
  return <div className="flex flex-col h-full min-h-0">
    <div className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 px-6 py-3 bg-white dark:bg-slate-900">
      <h1 className="font-semibold mr-4">资产管理</h1>
      {([['character', '角色'], ['location', '场景'], ['prop', '道具']] as const).map(([value, label]) => <button key={value} onClick={() => setTab(value)} className={`px-4 py-2 rounded-lg text-sm ${tab === value ? 'bg-indigo-600 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{label}</button>)}
    </div>
    {tab === 'character' ? <div className="flex-1 min-h-0"><CharacterManager /></div> : <div className="flex-1 overflow-auto p-6">
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <p className="text-sm text-slate-500 flex-1">管理可重复使用的{tab === 'location' ? '场景环境' : '道具'}，生成素材后可在导演镜头中引用。</p>
        <select aria-label="提取资产的章节" value={chapterId} onChange={e => setChapterId(e.target.value)} className="p-2 rounded border dark:bg-slate-800">{chapters.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select>
        <button disabled={busy || !chapters.find(c => c.id === chapterId)?.content?.trim()} title={chapters.find(c => c.id === chapterId)?.content?.trim() ? '提取本章场景与道具' : '请先完成本章正文'} onClick={() => run(() => api.extractLibraryAssets(chapterId))} className="flex gap-2 items-center px-3 py-2 rounded bg-indigo-600 text-white disabled:opacity-50"><Sparkles size={15} />从正文提取</button>
        <button onClick={() => setEditing({ kind: selectedKind, name: '', description: '', visual_prompt: '' })} className="flex gap-2 items-center px-3 py-2 rounded border"><Plus size={15} />添加</button>
        <button aria-label="刷新资产" onClick={() => run(reload)} disabled={busy}><RefreshCw size={17} /></button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {assets.filter(a => a.kind === tab).map(a => <article key={a.id} className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900">
          {a.image_url ? <button className="block w-full" onClick={() => openPreview(resolveMediaUrl(a.image_url))}><img className="w-full aspect-[4/3] object-contain bg-slate-100 dark:bg-slate-950" src={resolveMediaUrl(a.image_url)} alt={a.name} /></button> : <div className="aspect-[4/3] flex items-center justify-center bg-slate-100 dark:bg-slate-950 text-slate-500">{a.status === 'generating' ? '正在生成素材…' : a.status === 'failed' ? '生成失败，可重试' : '尚未生成素材'}</div>}
          <div className="p-4"><div className="flex items-center gap-2"><h2 className="font-semibold flex-1">{a.name}</h2><span className="text-xs text-slate-400">v{a.revision}</span></div>
            <p className="text-sm text-slate-500 mt-2 whitespace-pre-wrap">{a.description}</p>
            <div className="flex items-center gap-3 mt-4">
              <button disabled={busy || a.status === 'generating' || !a.visual_prompt} onClick={() => run(() => api.generateLibraryAsset(a.id))} className="text-sm text-indigo-500 disabled:opacity-50">{a.image_url ? '重新生成' : '生成素材'}</button>
              <button aria-label={`编辑${a.name}`} disabled={busy || a.status === 'generating'} onClick={() => setEditing(a)}><Pencil size={15} /></button>
              <button aria-label={`删除${a.name}`} disabled={busy || a.status === 'generating'} onClick={() => { if (confirm(`删除“${a.name}”？`)) void run(() => api.deleteLibraryAsset(a.id)); }}><Trash2 size={15} /></button>
              {a.status === 'failed' && a.task_id && <button className="text-xs text-red-500" onClick={() => run(async () => { const task = await api.getAssetTask(a.task_id!); showToast(task.error || '任务中断，请重试', 'error'); })}>查看原因</button>}
            </div>
          </div>
        </article>)}
      </div>
      {!assets.some(a => a.kind === tab) && <p className="text-slate-500 p-8 text-center">暂无{tab === 'location' ? '场景' : '道具'}。选择已有正文的章节提取，或手动添加。</p>}
    </div>}
    {editing && <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-5"><form onSubmit={e => { e.preventDefault(); void run(async () => {
      const data = { kind: editing.kind, name: editing.name, description: editing.description, visual_prompt: editing.visual_prompt };
      if (editing.id) await api.updateLibraryAsset(editing.id, editing.revision!, data); else await api.createLibraryAsset(projectId, data);
      setEditing(null);
    }); }} className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl p-6 space-y-4">
      <div className="flex items-center"><h2 className="font-semibold flex-1">{editing.id ? '编辑资产' : '添加资产'}</h2><button type="button" aria-label="关闭" onClick={() => setEditing(null)}><X size={18} /></button></div>
      <label className="block text-sm">名称<input required maxLength={120} value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} className="block border rounded p-2 w-full mt-1 dark:bg-slate-800" /></label>
      <label className="block text-sm">外观与连续性描述<textarea maxLength={3000} rows={3} value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} className="block border rounded p-2 w-full mt-1 dark:bg-slate-800" /></label>
      <label className="block text-sm">英文视觉提示词<textarea maxLength={3000} rows={4} value={editing.visual_prompt || ''} onChange={e => setEditing({ ...editing, visual_prompt: e.target.value })} className="block border rounded p-2 w-full mt-1 dark:bg-slate-800" /></label>
      {editing.id && <p className="text-xs text-amber-600">保存外观修改会清空当前素材，引用该资产的镜头需要重新绑定。</p>}
      <button disabled={busy} className="bg-indigo-600 text-white rounded px-4 py-2 disabled:opacity-50">保存</button>
    </form></div>}
    {lightbox}
  </div>;
};
