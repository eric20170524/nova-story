import React from 'react';
import { Film, FileText, PlayCircle } from 'lucide-react';
import { Chapter, ChapterVideoStatus } from '../../types';
import { useLanguage } from '../../LanguageContext';

interface DirectorSidebarProps {
  chapters: Chapter[];
  selectedChapterId: string;
  onSelectChapter: (id: string) => void;
  chapterVideoStatus?: ChapterVideoStatus | null;
  onOpenChapterVideoModal?: () => void;
}

export const DirectorSidebar: React.FC<DirectorSidebarProps> = ({
  chapters,
  selectedChapterId,
  onSelectChapter,
  chapterVideoStatus,
  onOpenChapterVideoModal,
}) => {
  const { t } = useLanguage();

  return (
    <div className="w-16 lg:w-64 bg-white/90 dark:bg-[#0c1322]/90 border-r border-slate-200/80 dark:border-slate-800/80 flex flex-col flex-shrink-0 transition-all h-full min-h-0 backdrop-blur-sm">
      <div className="p-4 border-b border-slate-200/80 dark:border-slate-800/80 h-14 flex items-center justify-center lg:justify-start flex-shrink-0">
        <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2 text-sm">
          <Film size={17} className="text-indigo-600 dark:text-indigo-400" />
          <span className="hidden lg:block">{t('story.chapters')}</span>
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar min-h-0">
        {chapters.map((chapter) => {
          const isSelected = selectedChapterId === chapter.id;
          const isAssembled = isSelected && Boolean(chapterVideoStatus?.assembled?.available);
          return (
            <div
              key={chapter.id}
              onClick={() => onSelectChapter(chapter.id)}
              className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl cursor-pointer text-xs sm:text-sm transition-all ${
                isSelected
                  ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-semibold ring-1 ring-indigo-500/20 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
              title={chapter.title}
            >
              <div className="flex items-center gap-2.5 min-w-0 justify-center lg:justify-start">
                <FileText size={16} className={`flex-shrink-0 ${isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400 dark:text-slate-500'}`} />
                <span className="truncate hidden lg:block">{chapter.title}</span>
              </div>
              {isSelected && onOpenChapterVideoModal && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChapterVideoModal();
                  }}
                  title={isAssembled ? '播放本章整章成片' : '预览章节视频'}
                  className={`hidden lg:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold transition-colors shrink-0 ${
                    isAssembled
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/25'
                      : 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/25'
                  }`}
                >
                  <PlayCircle size={12} />
                  <span>{isAssembled ? '成片' : '预览'}</span>
                </button>
              )}
            </div>
          );
        })}
        {chapters.length === 0 && (
          <div className="p-4 text-center text-xs text-slate-400 dark:text-slate-500 hidden lg:block">{t('story.no_chapters')}</div>
        )}
      </div>
    </div>
  );
};
