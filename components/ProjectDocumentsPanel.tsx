import React, { useEffect, useState } from 'react';
import { FileText, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useToast } from '../ToastContext';
import {
  createProjectDocument,
  deleteProjectDocument,
  listProjectDocuments,
  previewProjectDocument,
  type ProjectDocumentPreview,
  type ProjectDocumentSummary,
  type ProjectDocumentType,
} from '../services/project_documents';

const TYPES: Array<{ value: ProjectDocumentType; label: string }> = [
  { value: 'outline', label: '大纲' },
  { value: 'worldbuilding', label: '世界观' },
  { value: 'character_notes', label: '人物笔记' },
  { value: 'reference', label: '参考资料' },
  { value: 'other', label: '其他' },
];

const typeLabel = (value: ProjectDocumentType) =>
  TYPES.find((item) => item.value === value)?.label || value;

export const ProjectDocumentsPanel: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const numericProjectId = Number(projectId);
  const [open, setOpen] = useState(false);
  const [documents, setDocuments] = useState<ProjectDocumentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<ProjectDocumentType>('reference');
  const [preview, setPreview] = useState<ProjectDocumentPreview | null>(null);

  const loadDocuments = async () => {
    if (!Number.isFinite(numericProjectId)) return;
    setLoading(true);
    try {
      setDocuments(await listProjectDocuments(numericProjectId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to load documents', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadDocuments();
  }, [open, numericProjectId]);

  const resetUpload = () => {
    setFile(null);
    setPreview(null);
  };

  const handlePreviewOrCommit = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      if (!preview) {
        setPreview(await previewProjectDocument(numericProjectId, file, documentType));
        return;
      }
      if (preview.duplicate_document) {
        showToast('该资料已存在于项目中。', 'error');
        return;
      }
      const created = await createProjectDocument(
        numericProjectId,
        file,
        documentType,
        preview.title
      );
      setDocuments((current) => [created, ...current]);
      resetUpload();
      showToast('附加资料已保存。', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to add document', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (document: ProjectDocumentSummary) => {
    if (!confirm(`删除附加资料“${document.name}”？`)) return;
    try {
      await deleteProjectDocument(numericProjectId, document.id);
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      showToast('附加资料已删除。', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to delete document', 'error');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-5 z-30 flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/95 px-4 py-2 text-sm font-medium text-slate-200 shadow-xl hover:border-indigo-500/50 hover:text-indigo-300"
        title={t('project_documents.open', '附加资料')}
      >
        <FileText size={16} />
        <span>{t('project_documents.open', '附加资料')}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm">
          <div className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-800 bg-slate-950 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-5 py-4 backdrop-blur">
              <div>
                <h2 className="text-lg font-semibold text-white">{t('project_documents.title', '项目附加资料')}</h2>
                <p className="mt-0.5 text-xs text-slate-500">TXT / Markdown · 不自动覆盖正文或 Story Bible</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded p-2 text-slate-500 hover:bg-slate-800 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-5 p-5">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Plus size={16} /> 添加资料
                </div>
                <div className="grid gap-3 sm:grid-cols-[150px_1fr]">
                  <select
                    value={documentType}
                    disabled={busy}
                    onChange={(event) => {
                      setDocumentType(event.target.value as ProjectDocumentType);
                      setPreview(null);
                    }}
                    className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                  >
                    {TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                  <input
                    type="file"
                    accept=".txt,text/plain,.md,.markdown,text/markdown"
                    disabled={busy}
                    onChange={(event) => {
                      setFile(event.target.files?.[0] || null);
                      setPreview(null);
                    }}
                    className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-indigo-500/10 file:px-2 file:py-1 file:text-indigo-300"
                  />
                </div>

                {preview && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-200">{preview.title}</span>
                      <span className="text-xs text-slate-500">{preview.source.format.toUpperCase()}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                      <span>{preview.content_characters} 字符</span>
                      <span>{preview.line_count} 行</span>
                      {preview.heading_count > 0 && <span>{preview.heading_count} 个标题</span>}
                    </div>
                    <div className="mt-3 rounded bg-emerald-500/5 px-2 py-1.5 text-xs text-emerald-300/80">
                      安全预览：不会修改章节正文，不会修改 Story Bible，当前不会自动注入 AI Context。
                    </div>
                    {preview.duplicate_document && (
                      <div className="mt-2 rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
                        重复资料：已存在“{preview.duplicate_document.name}”。
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={!file || busy || Boolean(preview?.duplicate_document)}
                    onClick={handlePreviewOrCommit}
                    className="flex min-w-28 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500"
                  >
                    {busy && <Loader2 size={15} className="animate-spin" />}
                    {preview ? '确认添加' : '解析预览'}
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-slate-300">已添加资料</h3>
                  <span className="text-xs text-slate-600">{documents.length}</span>
                </div>
                {loading ? (
                  <div className="flex justify-center py-10 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
                ) : documents.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 py-10 text-center text-sm text-slate-600">暂无附加资料</div>
                ) : (
                  <div className="space-y-2">
                    {documents.map((document) => {
                      let metadata: Record<string, unknown> = {};
                      try { metadata = document.metadata_json ? JSON.parse(document.metadata_json) : {}; } catch { metadata = {}; }
                      return (
                        <div key={document.id} className="flex items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-200">{document.name}</div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              <span>{typeLabel(document.document_type)}</span>
                              <span>{document.source_format.toUpperCase()}</span>
                              {typeof metadata.content_characters === 'number' && <span>{metadata.content_characters} 字符</span>}
                            </div>
                            {document.source_filename && <div className="mt-1 truncate text-[11px] text-slate-600">{document.source_filename}</div>}
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleDelete(document)}
                            className="rounded p-1.5 text-slate-600 hover:bg-red-500/10 hover:text-red-400"
                            aria-label="删除附加资料"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
