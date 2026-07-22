import React from 'react';
import { Film, FileText } from 'lucide-react';
import { Chapter } from '../../types';
import { useLanguage } from '../../LanguageContext';

interface DirectorSidebarProps {
  chapters: Chapter[];
  selectedChapterId: string;
  onSelectChapter: (id: string) => void;
}

export const DirectorSidebar: React.FC<DirectorSidebarProps> = ({
  chapters,
  selectedChapterId,
  onSelectChapter
}) => {
  const { t } = useLanguage();

  return (
    <div className="w-16 lg:w-64 bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0 transition-all">
      <div className="p-4 border-b border-slate-800 h-14 flex items-center justify-center lg:justify-start">
        <h3 className="font-semibold text-slate-300 flex items-center gap-2">
          <Film size={18} />
          <span className="hidden lg:block">{t('story.chapters')}</span>
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {chapters.map((chapter) => (
          <div
            key={chapter.id}
            onClick={() => onSelectChapter(chapter.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm transition-colors justify-center lg:justify-start ${
              selectedChapterId === chapter.id 
                ? 'bg-indigo-600/20 text-indigo-300' 
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
            title={chapter.title}
          >
            <FileText size={18} className="flex-shrink-0" />
            <span className="truncate hidden lg:block">{chapter.title}</span>
          </div>
        ))}
        {chapters.length === 0 && (
          <div className="p-4 text-center text-xs text-slate-600 hidden lg:block">{t('story.no_chapters')}</div>
        )}
      </div>
    </div>
  );
};
