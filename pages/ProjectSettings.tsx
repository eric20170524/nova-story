import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Loader2, Trash2, AlertCircle, Palette, BookOpen, Library, SlidersHorizontal, FileText } from 'lucide-react';
import { api } from '../services/api';
import { normalizeProjectOutputSpec } from '../services/imageOutputSpec';
import { ImageOutputSpec, Project, VideoWorkflowId } from '../types';
import { PROJECT_VIDEO_WORKFLOW_IDS, readProjectVideoWorkflow } from '../services/videoWorkflowPolicy';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import {
  formatVisualStyleLabel,
  getVisualStyles,
  STANDARD_VISUAL_STYLES,
  styleLoraRecipeLocaleKey,
  type VisualStyleDef,
} from '../constants';
import { ProjectDocumentsPanel } from '../components/ProjectDocumentsPanel';

type SettingsTab = 'overview' | 'story' | 'glossary' | 'documents' | 'advanced';

const fieldClass =
  'w-full bg-slate-50/80 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500 transition-all shadow-sm';

function SectionCard({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200/80 dark:border-slate-800/80 bg-white dark:bg-slate-900/50 p-5 sm:p-6 shadow-sm transition-colors">
      <header className="mb-3.5">
        <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-slate-100">
          <span className="text-indigo-600 dark:text-indigo-400">{icon}</span>
          {title}
        </h2>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{hint}</p> : null}
      </header>
      <div className="space-y-3.5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  hintClass = 'text-slate-500 dark:text-slate-400',
  children,
}: {
  label: string;
  hint?: string;
  hintClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">{label}</div>
      {children}
      {hint ? (
        <p className={`mt-1 line-clamp-2 text-[11px] leading-snug ${hintClass}`} title={hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  testId,
  tone = 'indigo',
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string; title?: string }>;
  testId: string;
  tone?: 'indigo' | 'nsfw';
}) {
  return (
    <div
      role="radiogroup"
      data-testid={testId}
      className="grid gap-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950/80 p-1 shadow-inner"
      style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const active = option.value === value;
        const activeClass =
          tone === 'nsfw' && option.value === 'on'
            ? 'bg-rose-600 text-white shadow-sm'
            : tone === 'nsfw' && option.value === 'off'
              ? 'bg-slate-600 text-white shadow-sm'
              : 'bg-indigo-600 text-white shadow-sm';
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title || option.label}
            data-testid={`${testId}-${option.value}`}
            onClick={() => onChange(option.value)}
            className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-all ${
              active ? activeClass : 'text-slate-600 dark:text-slate-400 hover:bg-white/60 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export const ProjectSettings: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [visualStyles, setVisualStyles] = useState<VisualStyleDef[]>(() => getVisualStyles());
  
  // Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [defaultStyle, setDefaultStyle] = useState(STANDARD_VISUAL_STYLES[0].value);
  const [defaultModelType, setDefaultModelType] = useState<'pony' | 'sd15' | 'redcraft_krea2'>('pony');
  const [defaultWorkflowId, setDefaultWorkflowId] = useState<number | null>(null);
  const [videoWorkflowId, setVideoWorkflowId] = useState<VideoWorkflowId | null>(null);
  const [outputSpec, setOutputSpec] = useState<Required<ImageOutputSpec>>({
    aspect_ratio: '16:9',
    resolution: 'standard',
    orientation_policy: 'fixed',
  });
  const [workflows, setWorkflows] = useState<any[]>([]);
  /** inherit | on | off — project-level NSFW policy */
  const [nsfwMode, setNsfwMode] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [genre, setGenre] = useState('');
  const [storyStyle, setStoryStyle] = useState('');
  const [storyTagsText, setStoryTagsText] = useState('');
  const [pov, setPov] = useState('');
  const [tone, setTone] = useState('');
  const [mainPlot, setMainPlot] = useState('');
  const [characterRelations, setCharacterRelations] = useState('');
  const [glossary, setGlossary] = useState<
    Array<{ id: number; term: string; definition?: string | null; category?: string | null }>
  >([]);
  const [newTerm, setNewTerm] = useState('');
  const [newDefinition, setNewDefinition] = useState('');
  const [newCategory, setNewCategory] = useState('');
  /** Preserve unknown keys (e.g. agent_prompts_override written via API) on save */
  const [settingsBase, setSettingsBase] = useState<Record<string, unknown>>({});
  const [promptOverrideJson, setPromptOverrideJson] = useState('');
  const [editingGlossaryId, setEditingGlossaryId] = useState<number | null>(null);
  const [editTerm, setEditTerm] = useState('');
  const [editDefinition, setEditDefinition] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [tab, setTab] = useState<SettingsTab>('overview');

  useEffect(() => {
    if (id) {
      loadProject();
      api
        .listGlossary(Number(id))
        .then((rows) => setGlossary(Array.isArray(rows) ? rows : []))
        .catch(() => setGlossary([]));
    }
    api.getWorkflows().then((data) => {
      if (Array.isArray(data)) setWorkflows(data);
    }).catch(console.error);
  }, [id]);

  useEffect(() => {
    const refresh = () => {
      const styles = getVisualStyles();
      setVisualStyles(styles);
      setDefaultStyle((prev) => (styles.some((s) => s.value === prev) ? prev : STANDARD_VISUAL_STYLES[0].value));
    };
    window.addEventListener('novastory-advanced-styles-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('novastory-advanced-styles-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const loadProject = async () => {
    try {
      const data = await api.getProject(Number(id));
      setProject(data);
      setTitle(data.title);
      setDescription(data.description || '');
      
      // Parse settings JSON if available
      try {
          const raw = data.settings;
          const settingsObj = typeof raw === 'string'
            ? (raw ? JSON.parse(raw) : {})
            : (raw && typeof raw === 'object' ? raw : {});
          setSettingsBase(settingsObj && typeof settingsObj === 'object' ? { ...settingsObj } : {});
          const imageSettings = settingsObj.image_generation || {};
          if (imageSettings.style) setDefaultStyle(imageSettings.style);
          if (imageSettings.model === 'sd15' || imageSettings.model === 'pony' || imageSettings.model === 'redcraft_krea2') {
              setDefaultModelType(imageSettings.model);
          }
          setDefaultWorkflowId(typeof imageSettings.workflow_id === 'number' ? imageSettings.workflow_id : null);
          setVideoWorkflowId(readProjectVideoWorkflow(settingsObj));
          setOutputSpec(normalizeProjectOutputSpec(imageSettings.output_spec));
          setNsfwMode(imageSettings.nsfw_mode === 'on' || imageSettings.nsfw_mode === 'off'
            ? imageSettings.nsfw_mode : 'inherit');
          setGenre(typeof settingsObj.genre === 'string' ? settingsObj.genre : '');
          setStoryStyle(typeof settingsObj.style === 'string' ? settingsObj.style : '');
          setStoryTagsText(
            Array.isArray(settingsObj.story_tags)
              ? settingsObj.story_tags
                  .filter((tag: unknown): tag is string => typeof tag === 'string')
                  .join(', ')
              : ''
          );
          setPov(typeof settingsObj.pov === 'string' ? settingsObj.pov : '');
          setTone(typeof settingsObj.tone === 'string' ? settingsObj.tone : '');
          setMainPlot(typeof settingsObj.main_plot === 'string' ? settingsObj.main_plot : '');
          setCharacterRelations(
            typeof settingsObj.character_relations === 'string'
              ? settingsObj.character_relations
              : ''
          );
          if (
            settingsObj.agent_prompts_override &&
            typeof settingsObj.agent_prompts_override === 'object'
          ) {
            setPromptOverrideJson(
              JSON.stringify(settingsObj.agent_prompts_override, null, 2)
            );
          } else {
            setPromptOverrideJson('');
          }
      } catch (e) {
          console.error("Failed to parse project settings", e);
      }
    } catch (e) {
      console.error(e);
      showToast(t("settings.failed_load", "Failed to load project"), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setSaving(true);
    
    try {
        if (defaultWorkflowId != null && !workflows.some((wf) => wf.id === defaultWorkflowId && wf.model_family === defaultModelType)) {
          showToast(t('project_settings.workflow_invalid', '所选工作流已失效或与项目模型不匹配'), 'error');
          return;
        }
        let agent_prompts_override: Record<string, string> | undefined;
        if (promptOverrideJson.trim()) {
          try {
            const parsed = JSON.parse(promptOverrideJson);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              agent_prompts_override = parsed;
            } else {
              throw new Error('override must be object');
            }
          } catch {
            showToast(
              t('project_settings.prompt_override_invalid', 'Invalid prompt override JSON'),
              'error'
            );
            setSaving(false);
            return;
          }
        }

        const storyTags = Array.from(new Set(
          storyTagsText
            .split(/[，,、/／|]+/)
            .map((tag) => tag.trim())
            .filter(Boolean)
        )).slice(0, 20);

        // Merge so API-only keys (and any future fields) are not wiped on save
        const settingsJson = JSON.stringify({
            ...settingsBase,
            image_generation: {
              model: defaultModelType,
              workflow_id: defaultWorkflowId,
              style: defaultStyle,
              output_spec: outputSpec,
              nsfw_mode: nsfwMode,
            },
            video_generation: {
              workflow_id: videoWorkflowId,
            },
            genre,
            style: storyStyle,
            story_tags: storyTags,
            pov,
            tone,
            main_plot: mainPlot,
            character_relations: characterRelations,
            ...(agent_prompts_override
              ? { agent_prompts_override }
              : promptOverrideJson.trim() === ''
                ? { agent_prompts_override: undefined }
                : {}),
        });

        await api.updateProject(project.id, {
            title,
            description,
            settings: settingsJson
        });
        setSettingsBase(JSON.parse(settingsJson));
        
        window.dispatchEvent(new Event('novastory-project-settings-changed'));
        
        showToast(t("settings.updated", "Project updated successfully"), 'success');
    } catch (e) {
        console.error(e);
        showToast(t("settings.failed_update", "Failed to update project"), 'error');
    } finally {
        setSaving(false);
    }
  };

  const handleDelete = async () => {
      if (!project) return;
      if (!confirm(t('dashboard.confirm_delete'))) return;
      
      setDeleting(true);
      try {
          await api.deleteProject(project.id);
          showToast(t("settings.deleted", "Project deleted"), 'success');
          navigate('/');
      } catch (e) {
          console.error(e);
          showToast(t("settings.failed_delete", "Failed to delete project"), 'error');
          setDeleting(false);
      }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-950 p-12 text-slate-400">
        <Loader2 className="animate-spin text-indigo-500 mr-2" size={20} />
        {t('dashboard.loading')}
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-950 p-12 text-rose-500">
        {t('project_settings.not_found')}
      </div>
    );
  }

  const canvasValue: '1:1' | '16:9' | '9:16' | 'auto' =
    outputSpec.orientation_policy === 'auto_by_shot' || outputSpec.aspect_ratio === 'auto'
      ? 'auto'
      : outputSpec.aspect_ratio === '1:1'
        || outputSpec.aspect_ratio === '16:9' || outputSpec.aspect_ratio === '9:16'
        ? outputSpec.aspect_ratio
        : '16:9';

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: t('project_settings.tab_overview'), icon: <Palette size={14} /> },
    { id: 'story', label: t('project_settings.tab_story'), icon: <BookOpen size={14} /> },
    { id: 'documents', label: t('project_settings.tab_documents', '附加资料'), icon: <FileText size={14} /> },
    { id: 'glossary', label: t('project_settings.tab_glossary'), icon: <Library size={14} /> },
    { id: 'advanced', label: t('project_settings.tab_advanced'), icon: <SlidersHorizontal size={14} /> },
  ];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-slate-50/50 dark:bg-slate-950 transition-colors">
      <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-800/80 bg-white/90 dark:bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 pb-2 pt-3.5 sm:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold tracking-tight text-slate-900 dark:text-white sm:text-lg">
              {t('project_settings.title')}
            </h1>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{t('project_settings.subtitle')}</p>
          </div>
          <button
            type="submit"
            form="project-settings-form"
            disabled={saving}
            data-testid="project-settings-save"
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition-all shadow-md shadow-indigo-600/20 hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
            {t('project_settings.save')}
          </button>
        </div>
        <div role="tablist" className="mx-auto flex max-w-6xl gap-1.5 overflow-x-auto px-4 pb-2 sm:px-6 custom-scrollbar">
          {tabs.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`project-settings-tab-${item.id}`}
                onClick={() => setTab(item.id)}
                className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all ${
                  active
                    ? item.id === 'advanced'
                      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 shadow-sm'
                      : 'bg-indigo-50 text-indigo-700 dark:bg-slate-800 dark:text-indigo-300 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {item.icon}
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-16 custom-scrollbar">
        <form
          id="project-settings-form"
          data-testid="project-settings-form"
          onSubmit={handleSave}
          className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-5"
        >
          {tab === 'overview' && (
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <SectionCard icon={<FileText size={15} />} title={t('project_settings.general')}>
                <Field label={t('dashboard.field_title')}>
                  <input
                    type="text"
                    required
                    data-testid="project-settings-title"
                    className={fieldClass}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
                <Field label={t('dashboard.field_desc')}>
                  <textarea
                    data-testid="project-settings-description"
                    className={`${fieldClass} h-24 resize-none`}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <button
                  type="button"
                  data-testid="project-settings-story-jump"
                  onClick={() => setTab('story')}
                  className="w-full rounded-xl border border-dashed border-slate-300 dark:border-slate-700/80 bg-slate-50/70 dark:bg-slate-950/40 px-3.5 py-3 text-left transition-colors hover:border-indigo-500/50 hover:bg-indigo-50/30 dark:hover:bg-slate-950/70 shadow-sm"
                >
                  <div className="text-xs font-semibold text-slate-800 dark:text-slate-300">{t('project_settings.story_jump')}</div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    {[genre, storyStyle, tone].filter(Boolean).join(' · ') ||
                      mainPlot.trim() ||
                      t('project_settings.story_empty_hint')}
                  </p>
                </button>
                <button
                  type="button"
                  data-testid="project-settings-documents-jump"
                  onClick={() => setTab('documents')}
                  className="w-full rounded-xl border border-dashed border-slate-300 dark:border-slate-700/80 bg-slate-50/70 dark:bg-slate-950/40 px-3.5 py-3 text-left transition-colors hover:border-indigo-500/50 hover:bg-indigo-50/30 dark:hover:bg-slate-950/70 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-300">{t('project_documents.title', '项目附加资料')}</div>
                    <span className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium">查看资料库 →</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    TXT / Markdown 大纲与背景资料；不污染正文，按需开启 AI 上下文。
                  </p>
                </button>
              </SectionCard>

              <SectionCard
                icon={<Palette size={15} />}
                title={t('project_settings.defaults')}
                hint={t('project_settings.default_style_desc')}
              >
                <Field
                  label={t('project_settings.default_style')}
                  hint={t(styleLoraRecipeLocaleKey(defaultStyle))}
                  hintClass="text-indigo-600 dark:text-indigo-300/80"
                >
                  <select
                    data-testid="project-settings-style"
                    className={fieldClass}
                    value={defaultStyle}
                    onChange={(e) => setDefaultStyle(e.target.value)}
                  >
                    {visualStyles.map((s) => (
                      <option key={s.value} value={s.value}>
                        {formatVisualStyleLabel(s, t(`director.styles.${s.value}`) || s.label)}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label={t('project_settings.project_model', '项目出图模型')}
                  hint={t('project_settings.project_model_desc', '只选择底模家族。下面列出全部已注册的生图工作流。')}>
                  <select
                    data-testid="project-settings-model"
                    className={fieldClass}
                    value={defaultModelType}
                    onChange={(e) => {
                      setDefaultModelType(e.target.value as 'pony' | 'sd15' | 'redcraft_krea2');
                      setDefaultWorkflowId(null);
                    }}
                  >
                    <option value="pony">{t('project_settings.model_pony')}</option>
                    <option value="redcraft_krea2">{t('project_settings.model_redcraft')}</option>
                    <option value="sd15">{t('project_settings.model_sd15')}</option>
                  </select>
                </Field>

                <Field label={t('project_settings.project_workflow', '项目生图工作流')}
                  hint={t('project_settings.project_workflow_desc', '列出全部已注册的生图工作流，按底模分组。选择其他底模的工作流会同时切换项目出图模型。视频工作流不在这里。')}>
                  <select data-testid="project-settings-workflow" className={fieldClass}
                    value={defaultWorkflowId ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (!value) {
                        setDefaultWorkflowId(null);
                        return;
                      }
                      const workflow = workflows.find((item) => String(item.id) === value);
                      const family = workflow?.model_family;
                      if (family === 'pony' || family === 'sd15' || family === 'redcraft_krea2') {
                        setDefaultModelType(family);
                        setDefaultWorkflowId(Number(value));
                      }
                    }}>
                    <option value="">{t('project_settings.workflow_auto', '自动匹配')}</option>
                    {defaultWorkflowId != null && !workflows.some((wf) => wf.id === defaultWorkflowId) && (
                      <option value={defaultWorkflowId}>{t('project_settings.workflow_invalid', '所选工作流已失效或与项目模型不匹配')}</option>
                    )}
                    {(['pony', 'redcraft_krea2', 'sd15'] as const).map((family) => {
                      const familyWorkflows = workflows.filter((wf) => wf.model_family === family);
                      if (!familyWorkflows.length) return null;
                      return (
                        <optgroup key={family} label={t(`project_settings.model_${family === 'redcraft_krea2' ? 'redcraft' : family}`)}>
                          {familyWorkflows.map((wf) => (
                            <option key={wf.id} value={wf.id}>{wf.name}</option>
                          ))}
                        </optgroup>
                      );
                    })}
                    {workflows.some((wf) => wf.model_family === 'flux') && (
                      <optgroup label={t('project_settings.workflow_retired', '已退役')}>
                        {workflows.filter((wf) => wf.model_family === 'flux').map((wf) => (
                          <option key={wf.id} value={wf.id} disabled>{wf.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </Field>

                <Field label={t('project_settings.video_workflow', '默认生视频工作流')}
                  hint={t('project_settings.video_workflow_desc', '普通镜头使用这里的默认。镜头已有尾帧时仍用 FL2VA，已有引导帧时仍用 Multi-Frame。单个镜头可以临时改。')}>
                  <select data-testid="project-settings-video-workflow" className={fieldClass}
                    value={videoWorkflowId ?? ''}
                    onChange={(e) => setVideoWorkflowId((e.target.value || null) as VideoWorkflowId | null)}>
                    <option value="">{t('project_settings.video_workflow_auto', '按镜头参考自动选择')}</option>
                    {PROJECT_VIDEO_WORKFLOW_IDS.map((id) => (
                      <option key={id} value={id}>{t(`project_settings.video_${id}`)}</option>
                    ))}
                  </select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('project_settings.canvas_mode')}>
                    <Segmented
                      testId="project-settings-canvas"
                      value={canvasValue}
                      onChange={(value) => {
                        setOutputSpec((current) => ({
                          ...current,
                          aspect_ratio: value === 'auto' ? '16:9' : value,
                          orientation_policy: value === 'auto' ? 'auto_by_shot' : 'fixed',
                        }));
                      }}
                      options={[
                        { value: '1:1', label: t('project_settings.canvas_square_short'), title: t('project_settings.canvas_square') },
                        { value: '16:9', label: t('project_settings.canvas_wide_short'), title: t('project_settings.canvas_wide') },
                        { value: '9:16', label: t('project_settings.canvas_tall_short'), title: t('project_settings.canvas_tall') },
                        { value: 'auto', label: t('project_settings.canvas_auto_short'), title: t('project_settings.canvas_auto') },
                      ]}
                    />
                  </Field>
                  <Field label={t('project_settings.output_resolution')} hint={t('project_settings.output_resolution_desc')}>
                    <Segmented
                      testId="project-settings-resolution"
                      value={outputSpec.resolution}
                      onChange={(resolution) => setOutputSpec((current) => ({ ...current, resolution }))}
                      options={[
                        { value: 'draft', label: t('project_settings.resolution_draft') },
                        { value: 'standard', label: t('project_settings.resolution_standard') },
                        { value: 'high', label: t('project_settings.resolution_high') },
                      ]}
                    />
                  </Field>
                </div>

                <Field label={t('project_settings.nsfw_mode')} hint={t('project_settings.nsfw_mode_desc')}>
                  <Segmented
                    testId="project-settings-nsfw"
                    tone="nsfw"
                    value={nsfwMode}
                    onChange={setNsfwMode}
                    options={[
                      { value: 'inherit', label: t('project_settings.nsfw_inherit_short'), title: t('project_settings.nsfw_inherit') },
                      { value: 'on', label: t('project_settings.nsfw_on_short'), title: t('project_settings.nsfw_on') },
                      { value: 'off', label: t('project_settings.nsfw_off_short'), title: t('project_settings.nsfw_off') },
                    ]}
                  />
                </Field>
              </SectionCard>
            </div>
          )}

          {tab === 'story' && (
            <SectionCard
              icon={<BookOpen size={15} />}
              title={t('project_settings.story_bible')}
              hint={t('project_settings.story_bible_desc')}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('project_settings.genre')}>
                  <input
                    data-testid="project-settings-genre"
                    className={fieldClass}
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                    placeholder={t('project_settings.placeholder_genre')}
                  />
                </Field>
                <Field label={t('project_settings.story_style')}>
                  <input
                    data-testid="project-settings-story-style"
                    className={fieldClass}
                    value={storyStyle}
                    onChange={(e) => setStoryStyle(e.target.value)}
                    placeholder={t('project_settings.placeholder_story_style')}
                  />
                </Field>
                <Field label={t('project_settings.pov')}>
                  <input
                    data-testid="project-settings-pov"
                    className={fieldClass}
                    value={pov}
                    onChange={(e) => setPov(e.target.value)}
                    placeholder={t('project_settings.placeholder_pov')}
                  />
                </Field>
                <Field label={t('project_settings.tone')}>
                  <input
                    data-testid="project-settings-tone"
                    className={fieldClass}
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    placeholder={t('project_settings.placeholder_tone')}
                  />
                </Field>
              </div>
              <Field label={t('project_settings.story_tags')} hint={t('project_settings.story_tags_desc')}>
                <input
                  data-testid="project-settings-tags"
                  className={fieldClass}
                  value={storyTagsText}
                  onChange={(e) => setStoryTagsText(e.target.value)}
                  placeholder={t('project_settings.placeholder_tags')}
                />
              </Field>
              <div className="grid gap-3 lg:grid-cols-2">
                <Field label={t('project_settings.main_plot')}>
                  <textarea
                    data-testid="project-settings-plot"
                    className={`${fieldClass} h-28 resize-y`}
                    value={mainPlot}
                    onChange={(e) => setMainPlot(e.target.value)}
                  />
                </Field>
                <Field label={t('project_settings.character_relations')}>
                  <textarea
                    data-testid="project-settings-relations"
                    className={`${fieldClass} h-28 resize-y`}
                    value={characterRelations}
                    onChange={(e) => setCharacterRelations(e.target.value)}
                  />
                </Field>
              </div>
            </SectionCard>
          )}

          {tab === 'glossary' && (
            <SectionCard icon={<Library size={15} />} title={t('project_settings.glossary')}>
              <div className="grid gap-2 sm:grid-cols-[1fr_7rem_1.4fr_auto]">
                <input
                  className={fieldClass}
                  placeholder={t('project_settings.glossary_term')}
                  value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)}
                />
                <input
                  className={fieldClass}
                  placeholder={t('project_settings.glossary_cat')}
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                />
                <input
                  className={fieldClass}
                  placeholder={t('project_settings.glossary_def')}
                  value={newDefinition}
                  onChange={(e) => setNewDefinition(e.target.value)}
                />
                <button
                  type="button"
                  data-testid="project-settings-glossary-add"
                  className="rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 px-4 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 transition-colors shadow-sm"
                  onClick={async () => {
                    if (!id || !newTerm.trim()) return;
                    try {
                      const row = await api.createGlossary(Number(id), {
                        term: newTerm.trim(),
                        definition: newDefinition.trim() || undefined,
                        category: newCategory.trim() || undefined,
                      });
                      setGlossary((g) => [...g, row]);
                      setNewTerm('');
                      setNewDefinition('');
                      setNewCategory('');
                    } catch (e) {
                      console.error(e);
                      showToast(t('project_settings.glossary_fail'), 'error');
                    }
                  }}
                >
                  {t('project_settings.glossary_add')}
                </button>
              </div>
              <ul className="max-h-72 space-y-1.5 overflow-y-auto custom-scrollbar">
                {glossary.map((g) => (
                  <li key={g.id} className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/40 px-3.5 py-2.5 text-sm shadow-sm transition-colors">
                    {editingGlossaryId === g.id ? (
                      <div className="space-y-2">
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <input
                            className={`${fieldClass} text-xs`}
                            value={editTerm}
                            onChange={(e) => setEditTerm(e.target.value)}
                          />
                          <input
                            className={`${fieldClass} text-xs sm:w-28`}
                            value={editCategory}
                            onChange={(e) => setEditCategory(e.target.value)}
                            placeholder={t('project_settings.glossary_cat')}
                          />
                        </div>
                        <textarea
                          className={`${fieldClass} h-14 resize-none text-xs`}
                          value={editDefinition}
                          onChange={(e) => setEditDefinition(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-1 text-xs font-semibold text-white transition-colors"
                            onClick={async () => {
                              if (!id) return;
                              try {
                                const updated = await api.updateGlossary(Number(id), g.id, {
                                  term: editTerm.trim(),
                                  definition: editDefinition,
                                  category: editCategory || null,
                                });
                                setGlossary((list) => list.map((x) => (x.id === g.id ? updated : x)));
                                setEditingGlossaryId(null);
                              } catch (e) {
                                console.error(e);
                                showToast(t('project_settings.glossary_fail'), 'error');
                              }
                            }}
                          >
                            {t('project_settings.glossary_save')}
                          </button>
                          <button
                            type="button"
                            className="px-3 py-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                            onClick={() => setEditingGlossaryId(null)}
                          >
                            {t('dashboard.cancel', 'Cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-semibold text-indigo-600 dark:text-indigo-300">{g.term}</span>
                          {g.category && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">{g.category}</span>
                          )}
                          {g.definition && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{g.definition}</p>}
                        </div>
                        <div className="flex flex-shrink-0 gap-1">
                          <button
                            type="button"
                            className="p-1 text-xs text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors"
                            onClick={() => {
                              setEditingGlossaryId(g.id);
                              setEditTerm(g.term);
                              setEditDefinition(g.definition || '');
                              setEditCategory(g.category || '');
                            }}
                          >
                            {t('project_settings.glossary_edit')}
                          </button>
                          <button
                            type="button"
                            className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                            onClick={async () => {
                              if (!id) return;
                              try {
                                await api.deleteGlossary(Number(id), g.id);
                                setGlossary((list) => list.filter((x) => x.id !== g.id));
                              } catch (e) {
                                console.error(e);
                              }
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
                {glossary.length === 0 && (
                  <li className="py-6 text-center text-xs text-slate-400 dark:text-slate-600">{t('project_settings.glossary_empty')}</li>
                )}
              </ul>
            </SectionCard>
          )}

          {tab === 'documents' && id && (
            <div className="space-y-4">
              <ProjectDocumentsPanel projectId={id} embedded />
            </div>
          )}

          {tab === 'advanced' && (
            <SectionCard
              icon={<SlidersHorizontal size={15} />}
              title={t('project_settings.prompt_override')}
              hint={t('project_settings.prompt_override_desc')}
            >
              <textarea
                data-testid="project-settings-prompt-override"
                className={`${fieldClass} h-40 resize-y font-mono text-xs text-slate-800 dark:text-slate-300`}
                placeholder={t('project_settings.placeholder_prompt')}
                value={promptOverrideJson}
                onChange={(e) => setPromptOverrideJson(e.target.value)}
              />
            </SectionCard>
          )}
        </form>

        {tab === 'advanced' && (
          <div className="mx-auto max-w-6xl px-4 pb-6 sm:px-6">
            <div className="flex flex-col gap-3 rounded-2xl border border-red-200 dark:border-red-950/50 bg-red-50 dark:bg-red-950/15 px-5 py-4 sm:flex-row sm:items-center sm:justify-between shadow-sm">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-bold text-red-900 dark:text-red-200">
                  <AlertCircle size={15} />
                  {t('project_settings.delete_project')}
                </p>
                <p className="mt-0.5 text-xs text-red-700/80 dark:text-red-300/55">{t('project_settings.delete_desc')}</p>
              </div>
              <button
                type="button"
                data-testid="project-settings-delete"
                onClick={handleDelete}
                disabled={deleting}
                className="flex-shrink-0 rounded-xl bg-red-600 hover:bg-red-500 px-4 py-2 text-xs font-semibold text-white transition-all shadow-md shadow-red-600/20 disabled:opacity-50"
              >
                {deleting ? t('project_settings.deleting') : t('project_settings.delete_btn')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
