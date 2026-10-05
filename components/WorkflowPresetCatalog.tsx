import React from 'react';
import { Film, Workflow as WorkflowIcon } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { PROJECT_VIDEO_WORKFLOW_IDS } from '../services/videoWorkflowPolicy';
import type { Workflow } from '../types';

const IMAGE_FAMILIES = ['pony', 'redcraft_krea2', 'sd15', 'flux'] as const;

const familyLabelKey = (family: string) => {
  if (family === 'redcraft_krea2') return 'project_settings.model_redcraft';
  if (family === 'sd15') return 'project_settings.model_sd15';
  if (family === 'pony') return 'project_settings.model_pony';
  if (family === 'flux') return 'workflow.family_flux';
  return 'workflow.family_other';
};

export const WorkflowPresetCatalog: React.FC<{
  workflows: Array<Workflow & { model_family?: string }>;
  onToggle?: (workflow: Workflow) => void;
  onEdit?: (workflow: Workflow) => void;
}> = ({ workflows, onToggle, onEdit }) => {
  const { t } = useLanguage();
  const grouped = IMAGE_FAMILIES.map((family) => ({
    family,
    items: workflows.filter((workflow) => workflow.model_family === family),
  })).filter((group) => group.items.length > 0);
  const other = workflows.filter((workflow) => !IMAGE_FAMILIES.includes(workflow.model_family as typeof IMAGE_FAMILIES[number]));

  const renderImageCard = (workflow: Workflow & { model_family?: string }) => (
    <article
      key={workflow.id}
      data-testid={`settings-image-preset-${workflow.name}`}
      className="bg-slate-50/70 dark:bg-slate-900 p-4 sm:p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row justify-between items-start gap-4"
    >
      <div className="flex items-start gap-3.5 min-w-0">
        <div className={`p-3 rounded-xl flex-shrink-0 ${workflow.is_active ? 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/40' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200 dark:border-slate-700'}`}>
          <WorkflowIcon className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-slate-900 dark:text-white text-base truncate">{workflow.name}</h3>
          <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300 mt-1">
            {t(`workflow.presets.${workflow.name}`, workflow.description || t('workflow.preset_custom'))}
          </p>
        </div>
      </div>
      {(onToggle || onEdit) && (
        <div className="flex items-center gap-2 self-end sm:self-auto flex-shrink-0">
          {onToggle && (
            <button
              type="button"
              onClick={() => onToggle(workflow)}
              className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 text-xs font-semibold"
            >
              {workflow.is_active ? t('workflow.active') : t('workflow.inactive')}
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={() => onEdit(workflow)}
              className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              {t('workflow.edit')}
            </button>
          )}
        </div>
      )}
    </article>
  );

  return (
    <div className="space-y-8" data-testid="settings-workflow-catalog">
      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t('workflow.catalog_intro')}</p>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">{t('workflow.image_section')}</h2>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400 mt-1">{t('workflow.image_section_desc')}</p>
        </div>
        {grouped.map((group) => (
          <div key={group.family} className="space-y-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-300">
              {t(familyLabelKey(group.family))}
            </h3>
            <div className="grid gap-3">{group.items.map(renderImageCard)}</div>
          </div>
        ))}
        {other.length > 0 && (
          <div className="space-y-2.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('workflow.family_other')}</h3>
            <div className="grid gap-3">{other.map(renderImageCard)}</div>
          </div>
        )}
        {workflows.length === 0 && <p className="text-sm text-slate-400 text-center py-4">{t('workflow.no_workflows')}</p>}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900 dark:text-white">{t('workflow.video_section')}</h2>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400 mt-1">{t('workflow.video_section_desc')}</p>
        </div>
        <div className="grid gap-3">
          {PROJECT_VIDEO_WORKFLOW_IDS.map((id) => (
            <article
              key={id}
              data-testid={`settings-video-preset-${id}`}
              className="bg-slate-50/70 dark:bg-slate-900 p-4 sm:p-5 rounded-2xl border border-slate-200/80 dark:border-slate-800 flex items-start gap-3.5"
            >
              <div className="p-3 rounded-xl flex-shrink-0 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-900">
                <Film className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm">{t(`project_settings.video_${id}`)}</h3>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{t('workflow.built_in')}</span>
                </div>
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300 mt-1">{t(`workflow.video_presets.${id}`)}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
};
