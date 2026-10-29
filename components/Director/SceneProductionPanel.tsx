import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../../services/api';
import { useLanguage } from '../../LanguageContext';
import { useToast } from '../../ToastContext';
import { SceneProductionMediaPanel } from './SceneProductionMediaPanel';

type Draft = { owner: string; base_script_revision: number; base_continuity_revision: number; round: string; block_ids: string[]; moment: string; entity_ids: string[]; shots: any[]; dirty: boolean };
const key = (script: number, scene: string) => `novastory:production:${script}:${scene}`;
export const SceneProductionPanel: React.FC<{
  script: { id: number; revision: number } | null;
  onChanged: () => void;
  isOpen?: boolean;
  onToggleOpen?: () => void;
  hideStandaloneHeader?: boolean;
}> = ({ script, onChanged, isOpen, onToggleOpen, hideStandaloneHeader = false }) => {
  const { t } = useLanguage(), { showToast } = useToast();
  const [internalExpanded, setInternalExpanded] = useState(false);
  const expanded = isOpen !== undefined ? isOpen : internalExpanded;
  const toggle = onToggleOpen || (() => setInternalExpanded(!internalExpanded));
  const [view, setView] = useState<any>(null), [selected, setSelected] = useState(''), [draft, setDraft] = useState<Draft | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [replaceIds, setReplaceIds] = useState<number[]>([]), [preview, setPreview] = useState<any>(null);
  const message = (error:any) => {const key=`continuity.errors.${error.code}`;return t(key)===key?error.message:t(key);};
  const refresh = async (rebase = false) => {
    if (!script) return;
    try { const next = await api.getSceneProduction(script.id); setView(next); setSelected(value => value || next.scenes[0]?.scene_id || ''); setError(''); if (rebase) { setPreview(null); setDraft(value => value ? { ...value, base_script_revision: next.script_revision, base_continuity_revision: next.continuity_revision } : value); } }
    catch (error: any) { setError(message(error)); }
  };
  useEffect(() => { setView(null); setSelected(''); setDraft(null); setPreview(null); if (expanded) void refresh(); }, [script?.id, expanded]);
  useEffect(() => {
    if (!script || !selected || !view) return;
    let saved: Draft | null = null; try { saved = JSON.parse(localStorage.getItem(key(script.id, selected)) || 'null'); } catch { /* Empty draft. */ }
    setDraft(saved ? { ...saved, owner: key(script.id, selected) } : { owner: key(script.id, selected), base_script_revision: view.script_revision, base_continuity_revision: view.continuity_revision, round: 'skeleton', block_ids: [], moment: '', entity_ids: [], shots: [], dirty: false });
    setReplaceIds([]); setPreview(null);
  }, [script?.id, selected]);
  useEffect(() => { if (script && selected && draft?.owner === key(script.id, selected)) localStorage.setItem(draft.owner, JSON.stringify(draft)); }, [script?.id, selected, draft]);
  const patch = (change: Partial<Draft>) => { setDraft(value => value ? { ...value, ...change, dirty: true } : value); setPreview(null); };
  const scene = view?.scenes.find((scene: any) => scene.scene_id === selected);
  const candidates = (view?.candidates || []).filter((candidate: any) => candidate.payload.scope.target_scene_id === selected);
  const existing = (view?.timeline || []).filter((shot: any) => { try { return JSON.parse(shot.shot_spec || '{}').source?.script_scene_id === selected; } catch { return false; } });
  const addShot = () => {
    if (!draft?.moment || !draft.block_ids.length) return;
    const moment = scene.moments.find((moment: any) => `${moment.story_position.moment_id}|${moment.story_position.phase}` === draft.moment);
    if(!moment){setError(t('continuity.errors.CONTINUITY_STALE'));return;}
    const reads = moment.state.filter((cell: any) => draft.entity_ids.includes(cell.entity_id) && cell.knowledge_status === 'confirmed').map((cell: any) => ({ entity_id: cell.entity_id, attribute_id: cell.attribute_id }));
    patch({ shots: [...draft.shots, { block_ids: [...draft.block_ids], moment_id: moment.story_position.moment_id, phase: moment.story_position.phase, reads, duration: 5, shot_type: 'Medium Shot' }], block_ids: [], moment: '', entity_ids: [] });
  };
  const save = async () => {
    if (!script || !draft) return; setBusy(true);
    try { await api.createSceneProductionCandidate(script.id, { target_scene_id: selected, expected_script_revision: draft.base_script_revision, expected_continuity_revision: draft.base_continuity_revision, request_key: crypto.randomUUID(), round: draft.round, shots: draft.shots }); setDraft(value => value ? { ...value, dirty: false } : value); await refresh(); onChanged(); showToast(t('production.saved'), 'success'); }
    catch (error: any) { setError(message(error)); } finally { setBusy(false); }
  };
  const review = async (candidate: any) => {
    if (!script || draft?.dirty) return; setBusy(true);
    const body = { target_scene_id: selected, expected_script_revision: candidate.payload.scriptRevision, expected_continuity_revision: candidate.payload.continuityRevision, expected_candidate_revision: candidate.revision, expected_timeline_revision: view.timeline_revision, replace_scene_ids: replaceIds, request_key: crypto.randomUUID() };
    try { setPreview({ body, candidate_id: candidate.id, result: await api.previewSceneProductionApply(script.id, candidate.id, body) }); setError(''); } catch (error: any) { setError(message(error)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!script || !preview || draft?.dirty) return; setBusy(true);
    try { await api.applySceneProduction(script.id, preview.candidate_id, { ...preview.body, expected_impact_hash: preview.result.impact_hash }); setPreview(null); await refresh(); onChanged(); showToast(t('production.applied'), 'success'); }
    catch (error: any) { setError(message(error)); setPreview(null); } finally { setBusy(false); }
  };
  if (!script) return null;
  const button = 'rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 disabled:opacity-40 transition-all shadow-2xs cursor-pointer';
  return <section data-testid="production-panel" className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-shrink-0 min-w-0">
    {!hideStandaloneHeader && (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800">
        <button data-testid="production-toggle" className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200 hover:text-purple-600 dark:hover:text-purple-400 transition-colors cursor-pointer" onClick={toggle}>
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          <span>{t('production.title')}</span>
        </button>
      </div>
    )}
    {expanded && <div className="max-h-[48vh] overflow-y-auto min-w-0 p-4 space-y-3.5 text-xs custom-scrollbar">
      <button className={button} data-testid="production-refresh" disabled={busy} onClick={() => void refresh(true)}>{t('production.refresh')}</button>
      {error && <p className="break-words text-red-600" role="alert">{error}</p>}
      {view && <>
        <label className="block">{t('production.scene')} <select data-testid="production-scene" className="max-w-full rounded border bg-transparent p-1" value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>{view.scenes.map((scene: any) => <option key={scene.scene_id} value={scene.scene_id}>{scene.scene_id}</option>)}</select></label>
        {scene?.issue && <p className="break-words text-amber-600">{t(scene.issue_code?`continuity.errors.${scene.issue_code}`:'production.confirm_first')}</p>}
        {draft && <>
          <label className="block">{t('production.round')} <select data-testid="production-round" value={draft.round} disabled={busy} onChange={event => patch({ round: event.target.value })} className="rounded border bg-transparent p-1">{['continuity', 'skeleton', 'look', 'completion'].map(round => <option key={round} value={round}>{t(`production.round_${round}`)}</option>)}</select></label>
          <p>{t('production.source_instruction')}</p>
          {(scene?.blocks || []).map((block: any) => <label key={block.id} className="flex gap-2 break-words"><input type="checkbox" data-testid={`production-block-${block.id}`} disabled={busy || !!scene.issue} checked={draft.block_ids.includes(block.id)} onChange={event => patch({ block_ids: event.target.checked ? [...draft.block_ids, block.id] : draft.block_ids.filter(id => id !== block.id) })}/><span className="min-w-0">{block.text}</span></label>)}
          <label className="block">{t('production.moment')} <select data-testid="production-moment" className="max-w-full rounded border bg-transparent p-1" value={draft.moment} disabled={busy || !!scene?.issue} onChange={event => patch({ moment: event.target.value })}><option value="">{t('production.select_moment')}</option>{(scene?.moments || []).map((moment: any) => <option key={`${moment.story_position.moment_id}|${moment.story_position.phase}`} value={`${moment.story_position.moment_id}|${moment.story_position.phase}`}>{moment.story_position.moment_id} · {t(`continuity.${moment.story_position.phase}`)}</option>)}</select></label>
          <p>{t('production.physical_instruction')}</p>
          <div className="flex flex-wrap gap-3">{view.entities.filter((entity: any) => !['character', 'location'].includes(entity.kind)).map((entity: any) => <label key={entity.entity_id}><input type="checkbox" data-testid={`production-entity-${entity.entity_id}`} disabled={busy} checked={draft.entity_ids.includes(entity.entity_id)} onChange={event => patch({ entity_ids: event.target.checked ? [...draft.entity_ids, entity.entity_id] : draft.entity_ids.filter(id => id !== entity.entity_id) })}/> {entity.display_name} <span className="text-slate-400">({entity.entity_id})</span></label>)}</div>
          <button className={button} data-testid="production-add-shot" disabled={busy || !draft.moment || !draft.block_ids.length || draft.shots.length >= 20} onClick={addShot}>{t('production.add_shot')}</button>
          <div className="space-y-2">{draft.shots.map((shot, index) => <div className="rounded border p-2" key={index}><span>#{index + 1} · {shot.block_ids.map((id: string) => scene.blocks.find((block: any) => block.id === id)?.text).join(' / ')}</span><label className="block mt-1">{t('production.duration')} <input className="w-16 rounded border bg-transparent p-1" type="number" data-testid={`production-duration-${index}`} disabled={busy} min={1} max={15} value={shot.duration} onChange={event => patch({ shots: draft.shots.map((value, i) => i === index ? { ...value, duration: Number(event.target.value) } : value) })}/></label><button className={button} data-testid={`production-remove-shot-${index}`} disabled={busy} onClick={() => patch({ shots: draft.shots.filter((_, i) => i !== index) })}>{t('production.remove_shot')}</button></div>)}</div>
          {draft.dirty && <p className="text-amber-600" data-testid="production-dirty">{t('production.unsaved')}</p>}
          <button className={button} data-testid="production-save" disabled={busy || !!scene?.issue || (!draft.shots.length && draft.round !== 'continuity')} onClick={() => void save()}>{t('production.save')}</button>
        </>}
        {existing.length > 0 && <div className="space-y-1"><p>{t('production.replacement_instruction')}</p>{existing.map((shot: any) => <label className="block" key={shot.id}><input type="checkbox" data-testid={`production-replace-${shot.id}`} checked={replaceIds.includes(shot.id)} disabled={busy || !!draft?.dirty} onChange={event => { setReplaceIds(event.target.checked ? [...replaceIds, shot.id] : replaceIds.filter(id => id !== shot.id)); setPreview(null); }}/> #{shot.id} · {t('production.old_version_retained')}</label>)}</div>}
        {candidates.map((candidate: any) => <article key={candidate.id} className="rounded border p-2 space-y-2" data-testid="production-candidate"><p>{t(`production.round_${candidate.payload.round}`)} · {candidate.payload.shots.length} {t('production.shots')}</p><p className={candidate.payload.coverage.complete ? 'text-emerald-600' : 'text-amber-600'}>{candidate.payload.coverage.complete ? t('production.text_coverage_complete') : t('production.gaps')}{candidate.payload.coverage.gaps.map((gap: any) => <span className="block" key={gap.block_id}>{gap.text}</span>)}</p><button className={button} data-testid="production-preview" disabled={busy || !!draft?.dirty || !candidate.payload.shots.length} onClick={() => void review(candidate)}>{t('production.preview')}</button></article>)}
        {preview && <div className="rounded border border-amber-400 p-2 space-y-2" data-testid="production-impact"><p>{t('production.replace_count')} {preview.result.replacement_ids.length} · {t('production.new_count')} {preview.result.new_shot_count}</p><p>{t('production.retained_count')} {preview.result.preserved_other_scene_ids.length}</p>{Array.isArray(preview.result.placement) && <p data-testid="production-order">{t('production.order')} {preview.result.placement.map((item: { role: string; scene_id: number | null; shot_index: number }) => item.role === 'inserted' ? `+${item.shot_index + 1}` : `#${item.scene_id}`).join(' → ')}</p>}<button className={button} data-testid="production-apply" disabled={busy || !!draft?.dirty} onClick={() => void apply()}>{t('production.apply')}</button></div>}
        {existing.length > 0 && <SceneProductionMediaPanel key={selected} scriptId={script.id} targetSceneId={selected} shots={existing} disabled={busy || !!draft?.dirty} onChanged={() => { void refresh(); onChanged(); }}/>}
      </>}
    </div>}
  </section>;
};
