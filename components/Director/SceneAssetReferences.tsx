import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../services/api';

export const SceneAssetReferences: React.FC<{ sceneId: number }> = ({ sceneId }) => {
  const { id } = useParams();
  const [assets, setAssets] = useState<any[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([api.getLibraryAssets(Number(id)), api.getSceneAssetReferences(sceneId)]).then(([all, refs]) => {
      if (!active) return;
      setAssets(all); setSelected(refs.map(r => r.id)); setStale(refs.some(r => r.stale || r.status !== 'completed'));
    }).catch(e => { if (active) setNotice(e.message); });
    return () => { active = false; };
  }, [id, sceneId]);
  return <details className="text-xs border-t border-slate-200 dark:border-slate-800 p-3">
    <summary className="cursor-pointer font-medium">引用场景与道具素材 {selected.length > 0 && `(${selected.length})`}{stale && <span className="text-amber-500 ml-2">引用已过期</span>}</summary>
    <div className="mt-3 space-y-2">
      {assets.map(a => <label key={a.id} className="flex gap-2 items-center"><input type="checkbox" disabled={busy || a.status !== 'completed'} checked={selected.includes(a.id)} onChange={e => {
        setSelected(prev => e.target.checked ? [...prev.filter(assetId => a.kind !== 'location' || assets.find(row => row.id === assetId)?.kind !== 'location'), a.id] : prev.filter(assetId => assetId !== a.id));
      }} />{a.kind === 'location' ? '场景' : '道具'} · {a.name}{a.status !== 'completed' && <span className="text-slate-500">需先生成</span>}</label>)}
      {!assets.length && <p className="text-slate-500">请先在资产管理中提取或添加素材。</p>}
      <button disabled={busy} className="text-indigo-500 disabled:opacity-50" onClick={async () => {
        setBusy(true); setNotice('');
        try { await api.bindSceneAssets(sceneId, selected); setStale(false); setNotice('引用已保存，重新生成镜头后生效'); }
        catch (e: any) { setNotice(e.message); } finally { setBusy(false); }
      }}>保存引用</button>
      {notice && <p role="status" className="text-amber-600">{notice}</p>}
    </div>
  </details>;
};
