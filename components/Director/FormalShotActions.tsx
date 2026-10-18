import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  const open = matching.some((row) => row.chain_ready && row.live_verified);
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
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const gapText = (reason: string) => t(`director.formal_gap_${reason}`, reason);

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="formal-shot-actions">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="director-generate-draft"
          onClick={onDraft}
          disabled={draftBusy}
          className="bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1.5 rounded-full text-[11px] font-medium disabled:opacity-50"
        >
          <RefreshCw size={12} className={draftBusy ? 'inline animate-spin mr-1' : 'inline mr-1'} />
          {draftBusy ? t('director.status_generating') : t('director.generate_draft')}
        </button>
        <button
          type="button"
          data-testid="director-generate-production"
          onClick={onProduction}
          className="bg-emerald-700 hover:bg-emerald-600 text-white px-2.5 py-1.5 rounded-full text-[11px] font-medium"
        >
          {t('director.generate_production')}
        </button>
      </div>
      <div className="text-[10px] text-slate-500 dark:text-slate-400">
        <p>{t('director.formal_references')}</p>
        {names.length === 0 ? <p>{t('director.formal_references_empty')}</p> : <p>{names.join('、')}</p>}
        <p className="mt-1">{t('director.formal_gaps')}</p>
        <ul>
          {shownGaps.map((reason) => <li key={reason}>{gapText(reason)}</li>)}
        </ul>
      </div>
      {candidate?.asset_url && candidate.reference_hash && (
        <div className="flex flex-col gap-1 text-[10px]">
          <div className="flex flex-wrap gap-1">
            {CHECKS.map((key) => (
              <label key={key} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={Boolean(checks[key])}
                  onChange={(event) => setChecks((prev) => ({ ...prev, [key]: event.target.checked }))}
                />
                {t(`director.check_${key}`)}
              </label>
            ))}
          </div>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t('director.formal_note')}
            className="border border-slate-300 dark:border-slate-700 rounded px-1 py-0.5 bg-transparent"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="director-production-adopt"
              className="bg-emerald-700 text-white px-2 py-1 rounded-full"
              onClick={() => onDecide(candidate.version, 'accepted', checks, note, candidate.reference_hash || '')}
            >
              {t('director.adopt_formal')}
            </button>
            <button
              type="button"
              data-testid="director-production-reject"
              className="bg-slate-700 text-white px-2 py-1 rounded-full"
              onClick={() => onDecide(candidate.version, 'rejected', checks, note, candidate.reference_hash || '')}
            >
              {t('director.reject_formal')}
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
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-1 p-1" data-testid="formal-stage-strip">
      <p className="sm:col-span-3 text-[10px] text-slate-400">{t('director.keyframe_stages')}</p>
      {frames.map((frame) => (
        <figure key={frame.key} className="aspect-video bg-black flex flex-col min-w-0">
          {frame.url ? (
            <PreviewableImage src={frame.url} alt={frame.label} className="w-full h-full object-contain" />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[10px] text-slate-500">{t('director.stage_empty')}</div>
          )}
          <figcaption className="text-[10px] text-center text-slate-300 py-0.5">{frame.label}</figcaption>
        </figure>
      ))}
    </div>
  );
};
