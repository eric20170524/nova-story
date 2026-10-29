import React, { useEffect, useState } from 'react';
import { RefreshCw, CheckCircle2, AlertCircle, Sparkles, Check, X } from 'lucide-react';
import type { Scene, SceneVersionSummary } from '../../types';
import { useLanguage } from '../../LanguageContext';
import { PreviewableImage } from '../ImageLightbox';

export interface FormalCapabilityGap {
  id: string;
  reason: string | null;
  chain_ready?: boolean;
  live_verified?: boolean;
  family_match?: boolean;
}

const CHECKS = ['wardrobe', 'damage', 'count', 'holder', 'openings', 'space'] as const;

const visibleNames = (scene: Scene): string[] => {
  const spec = typeof scene.shot_spec === 'string'
    ? (() => { try { return JSON.parse(scene.shot_spec); } catch { return {}; } })()
    : scene.shot_spec || {};
  return Array.isArray(spec.visible_subjects) ? spec.visible_subjects.filter(Boolean) : [];
};

export function storyboardStages(scene: Scene) {
  const versions = scene.versions || [];
  const formal = versions.filter((version) => version.formal_stage === 'production' || version.label === 'formal-candidate');
  const adopted = formal.find((version) => version.version === scene.active_version && version.asset_url) || null;
  const candidates = formal.filter((version) => version.asset_url && version.version !== scene.active_version);
  const drafts = versions.filter((version) => version.formal_stage !== 'production' && version.label !== 'formal-candidate' && version.asset_url);
  const draft = drafts[drafts.length - 1]
    || (!adopted && scene.asset_url ? { version: scene.active_version || 1, asset_url: scene.asset_url, label: 'v1' } as SceneVersionSummary : null);
  return { draft, candidates, adopted };
}

export function shotMediaStage(stages: ReturnType<typeof storyboardStages>): 'formal' | 'candidate' | 'draft' | null {
  if (stages.adopted?.asset_url) return 'formal';
  if (stages.candidates[0]?.asset_url) return 'candidate';
  if (stages.draft?.asset_url) return 'draft';
  return null;
}

const blankChecks = (): Record<string, boolean> => Object.fromEntries(CHECKS.map((key) => [key, false]));

export const FormalShotActions: React.FC<{
  scene: Scene;
  capabilities?: FormalCapabilityGap[];
  draftBusy?: boolean;
  onDraft: () => void;
  onProduction: () => void;
  onDecide: (version: number, verdict: 'accepted' | 'rejected', checks: Record<string, boolean>, note: string, referenceHash: string) => void;
}> = ({ scene, capabilities = [], draftBusy = false, onDraft, onProduction, onDecide }) => {
  const { t } = useLanguage();
  const names = visibleNames(scene);
  const stages = storyboardStages(scene);
  const candidate = stages.candidates[0] || null;
  const matching = capabilities.filter((row) => row.family_match !== false);
  const open = matching.some((row) => (row.chain_ready || (row.live_verified && row.reason === null)) && row.live_verified);
  const gapReasons = [...new Set(matching.map((row) => row.reason).filter((reason): reason is string => Boolean(reason)))];
  const shownGaps = capabilities.length === 0
    ? ['status_unavailable']
    : matching.length === 0
      ? ['incompatible']
      : open
        ? []
        : gapReasons.length > 0
          ? gapReasons
          : ['not_live_verified'];

  const [checks, setChecks] = useState<Record<string, boolean>>(blankChecks);
  const [note, setNote] = useState('');
  const gapText = (reason: string) => t(`director.formal_gap_${reason}`, reason);
  const candidateVersion = candidate?.version ?? null;

  useEffect(() => {
    setChecks(blankChecks());
    setNote('');
  }, [scene.id, candidateVersion]);

  const effectiveChecks: Record<string, boolean> = Object.fromEntries(
    CHECKS.map((key) => [key, checks[key] === true])
  );
  const noteReady = note.trim().length > 0;
  const allChecked = CHECKS.every((key) => effectiveChecks[key]);

  return (
    <div className="flex flex-col gap-2 p-2.5 bg-slate-50/60 dark:bg-slate-900/60 border-t border-slate-200/70 dark:border-slate-800/70" data-testid="formal-shot-actions">
      {/* Draft and Production Action Buttons */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="director-generate-draft"
          onClick={onDraft}
          disabled={draftBusy}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1.5 rounded-lg text-[11px] font-medium disabled:opacity-50 transition-all flex items-center gap-1 shadow-2xs"
          title={t('director.formal_draft_title')}
        >
          <RefreshCw size={11} className={draftBusy ? 'animate-spin' : ''} />
          <span>{draftBusy ? t('director.status_generating') : t('director.generate_draft')}</span>
        </button>
        <button
          type="button"
          data-testid="director-generate-production"
          onClick={onProduction}
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all flex items-center gap-1 shadow-2xs"
          title={t('director.formal_production_title')}
        >
          <Sparkles size={11} />
          <span>{t('director.generate_production')}</span>
        </button>
      </div>

      {/* Reference Subjects & Capability Status */}
      <div className="text-[10px] space-y-1 bg-white dark:bg-slate-950/70 p-2 rounded-lg border border-slate-200/80 dark:border-slate-800/80">
        <div className="flex flex-wrap items-center gap-1">
          <span className="font-semibold text-slate-500 dark:text-slate-400">{t('director.formal_references')}:</span>
          {names.length === 0 ? (
            <span className="text-slate-400">{t('director.formal_references_empty')}</span>
          ) : (
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">
              {names.join('、')}
            </span>
          )}
          <span className="text-[9px] text-slate-500 dark:text-slate-400 ml-1">
            {t('director.formal_visible_subjects')}
          </span>
        </div>

        {shownGaps.length > 0 && (
          <div className="text-amber-600 dark:text-amber-400">
            <span className="font-semibold">{t('director.formal_gaps')}: </span>
            <span className="inline-flex flex-wrap gap-1">
              {shownGaps.map((reason) => (
                <span key={reason} className="inline-flex items-center gap-0.5">
                  <AlertCircle size={9} />
                  <span>{gapText(reason)}</span>
                </span>
              ))}
            </span>
          </div>
        )}
      </div>

      {candidate?.asset_url && candidate.reference_hash && (
        <div className="flex flex-col gap-1.5 p-2 bg-emerald-50/70 dark:bg-emerald-950/30 rounded-lg border border-emerald-300 dark:border-emerald-800/60 text-[10px]">
          <div className="flex items-center justify-between gap-1 text-emerald-800 dark:text-emerald-300 font-semibold">
            <span className="flex items-center gap-1">
              <CheckCircle2 size={12} className="text-emerald-600" />
              <span>{t('director.formal_candidate_title', { version: candidate.version })}</span>
            </span>
          </div>
          <p className="text-slate-600 dark:text-slate-300">{t('director.formal_checks_required')}</p>

          <div className="flex flex-wrap gap-1">
            {CHECKS.map((key) => (
              <span
                key={key}
                data-testid={`formal-check-badge-${key}`}
                data-passed={effectiveChecks[key] ? 'true' : 'false'}
                className={`px-1.5 py-0.5 rounded text-[9px] border flex items-center gap-0.5 ${
                  effectiveChecks[key]
                    ? 'bg-emerald-100/80 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                }`}
              >
                <span>{effectiveChecks[key] ? '✓' : '·'}</span>
                <span>{t(`director.check_${key}`)}</span>
              </span>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 p-1 bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800">
            {CHECKS.map((key) => (
              <label key={key} className="inline-flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  data-testid={`formal-check-${key}`}
                  checked={effectiveChecks[key]}
                  onChange={(event) => setChecks((prev) => ({ ...prev, [key]: event.target.checked }))}
                  className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>{t(`director.check_${key}`)}</span>
              </label>
            ))}
          </div>

          <input
            value={note}
            data-testid="formal-review-note"
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('director.formal_note')}
            className="border border-emerald-200 dark:border-emerald-800/80 rounded px-1.5 py-1 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 focus:outline-hidden focus:ring-1 focus:ring-emerald-500"
          />

          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <button
              type="button"
              data-testid="director-production-adopt"
              disabled={!allChecked || !noteReady}
              className="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 rounded-md font-semibold flex items-center gap-1 transition-all shadow-2xs disabled:opacity-40"
              onClick={() => onDecide(
                candidate.version,
                'accepted',
                effectiveChecks,
                note.trim(),
                candidate.reference_hash || ''
              )}
            >
              <Check size={11} />
              <span>{t('director.adopt_formal')}</span>
            </button>
            <button
              type="button"
              data-testid="director-production-reject"
              disabled={!noteReady}
              className="bg-slate-600 hover:bg-slate-500 text-white px-2.5 py-1 rounded-md font-medium flex items-center gap-1 transition-all disabled:opacity-40"
              onClick={() => onDecide(
                candidate.version,
                'rejected',
                effectiveChecks,
                note.trim(),
                candidate.reference_hash || ''
              )}
            >
              <X size={11} />
              <span>{t('director.reject_formal')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const FormalStageStrip: React.FC<{ scene: Scene }> = ({ scene }) => {
  const { t } = useLanguage();
  const stages = storyboardStages(scene);
  const frames = [
    { key: 'draft', label: t('director.stage_draft'), url: stages.draft?.asset_url },
    { key: 'candidate', label: t('director.stage_candidate'), url: stages.candidates[0]?.asset_url },
    { key: 'adopted', label: t('director.stage_adopted'), url: stages.adopted?.asset_url },
  ];
  return (
    <div className="grid grid-cols-3 gap-1.5 p-2 bg-slate-950 border-t border-slate-800" data-testid="formal-stage-strip">
      <div className="col-span-3 flex items-center justify-between text-[10px] text-slate-400">
        <span>{t('director.keyframe_stages')}</span>
        <span className="text-[9px] text-slate-500">{t('director.stage_progress')}</span>
      </div>
      {frames.map((frame) => (
        <figure key={frame.key} className="aspect-video bg-slate-900 rounded border border-slate-800 overflow-hidden flex flex-col min-w-0">
          {frame.url ? (
            <PreviewableImage src={frame.url} alt={frame.label} className="w-full h-full object-contain" />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[9px] text-slate-500 font-mono">
              {t('director.stage_empty')}
            </div>
          )}
          <figcaption className="text-[9px] text-center text-slate-300 py-0.5 bg-slate-950/80 truncate px-1">
            {frame.label}
          </figcaption>
        </figure>
      ))}
    </div>
  );
};
