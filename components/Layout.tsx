import React, { useState, useRef, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Home, Settings, Globe, User, Sun, Moon } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useTheme } from '../ThemeContext';
import { VramHealthBadge } from './VramHealthBadge';

export const Layout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language, setLanguage } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const toggleLanguage = () => {
    setLanguage(language === 'zh' ? 'en' : 'zh');
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNavigation = (path: string) => {
    navigate(path);
    setIsMenuOpen(false);
  };

  const isDark = theme === 'dark';

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 overflow-hidden font-sans transition-colors duration-200">
      {/* Sidebar - Compact Fixed Width */}
      <aside className="w-16 bg-white/90 dark:bg-[#0c1322]/95 backdrop-blur-md border-r border-slate-200 dark:border-slate-800/80 flex flex-col flex-shrink-0 transition-all duration-300 z-40 shadow-sm dark:shadow-2xl">
        
        {/* Logo */}
        <div className="h-16 flex items-center justify-center border-b border-slate-200/80 dark:border-slate-800/80">
          <button
             onClick={() => navigate('/')}
             className="w-10 h-10 rounded-2xl overflow-hidden shadow-md shadow-indigo-500/20 ring-1 ring-indigo-500/30 hover:ring-indigo-500/70 hover:scale-105 active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 bg-gradient-to-tr from-indigo-600 to-violet-500 p-0.5"
             title="NovaStory Studio"
             aria-label="NovaStory Home"
          >
            <img
              src="/logo-192.png"
              alt="NovaStory"
              className="w-full h-full object-cover rounded-[14px]"
              width={40}
              height={40}
              draggable={false}
            />
          </button>
        </div>

        {/* Main Nav Items */}
        <nav className="flex-1 py-4 flex flex-col items-center gap-3">
          <button
             onClick={() => handleNavigation('/')}
             className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
               location.pathname === '/' 
                 ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-semibold shadow-sm ring-1 ring-indigo-500/20' 
                 : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-200'
             }`}
             title={t('app.dashboard')}
          >
             <Home size={19} />
          </button>
          <button
             onClick={() => handleNavigation('/settings')}
             className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
               location.pathname === '/settings' 
                 ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-semibold shadow-sm ring-1 ring-indigo-500/20' 
                 : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-200'
             }`}
             title={t('app.settings')}
          >
             <Settings size={19} />
          </button>
        </nav>

        {/* Bottom Actions Area */}
        <div className="p-3 border-t border-slate-200/80 dark:border-slate-800/80 flex flex-col items-center gap-2 relative" ref={menuRef}>
          
          {/* Quick Theme Toggle Button */}
          <button
            onClick={toggleTheme}
            className="w-10 h-10 rounded-xl flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-200 transition-all hover:scale-105 active:scale-95"
            title={isDark ? t('theme.light_mode', '切换至白天模式') : t('theme.dark_mode', '切换至黑夜模式')}
            aria-label={t('theme.toggle', '切换主题')}
          >
            {isDark ? (
              <Sun size={19} className="text-amber-400 hover:rotate-45 transition-transform duration-300" />
            ) : (
              <Moon size={19} className="text-indigo-600 hover:-rotate-12 transition-transform duration-300" />
            )}
          </button>

          {/* Popup Menu */}
          {isMenuOpen && (
            <div className="absolute left-0 sm:left-full bottom-full sm:bottom-0 mb-2 sm:mb-0 sm:ml-3 w-60 sm:w-64 bg-white dark:bg-[#0f172a] border border-slate-200 dark:border-slate-700/80 rounded-2xl shadow-xl dark:shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-150">
               {/* User Info Header */}
               <div className="p-4 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/80 dark:bg-[#131c2e]/80">
                  <div className="flex items-center gap-3">
                     <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500 to-violet-500 text-white flex items-center justify-center text-xs font-bold shadow-sm">
                       NS
                     </div>
                     <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate">{t('app.director_role')}</div>
                        <div className="text-[10px] text-indigo-600 dark:text-indigo-400 font-bold uppercase tracking-wider">{t('app.plan')}</div>
                     </div>
                  </div>
               </div>
               
               <div className="p-2 space-y-1">
                 <button 
                    onClick={() => handleNavigation('/')}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                      location.pathname === '/' 
                        ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 font-medium' 
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                    }`}
                 >
                    <Home size={17} />
                    <span>{t('app.dashboard')}</span>
                 </button>

                 <button 
                    onClick={() => handleNavigation('/settings')}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                      location.pathname === '/settings' 
                        ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 font-medium' 
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white'
                    }`}
                 >
                    <Settings size={17} />
                    <span>{t('app.settings')}</span>
                 </button>

                 <div className="h-px bg-slate-100 dark:bg-slate-800 my-1 mx-1.5"></div>

                 {/* Theme Switcher in Popover */}
                 <button 
                    onClick={toggleTheme}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
                 >
                    <div className="flex items-center gap-3">
                      {isDark ? <Moon size={17} className="text-indigo-400" /> : <Sun size={17} className="text-amber-500" />}
                      <span>{t('theme.theme_mode', '主题模式')}</span>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded-md font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                      {isDark ? t('theme.dark', '黑夜') : t('theme.light', '白天')}
                    </span>
                 </button>

                 {/* Language Switcher */}
                 <button 
                    onClick={toggleLanguage}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
                 >
                    <div className="flex items-center gap-3">
                      <Globe size={17} />
                      <span>{language === 'zh' ? '语言 / Language' : 'Language / 语言'}</span>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded-md font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                      {language === 'zh' ? '中文' : 'EN'}
                    </span>
                 </button>
               </div>
            </div>
          )}

          {/* Avatar / Trigger Button */}
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
              isMenuOpen 
                ? 'bg-indigo-600 text-white ring-2 ring-indigo-400 ring-offset-2 ring-offset-white dark:ring-offset-slate-900 shadow-md' 
                : 'bg-slate-100 dark:bg-slate-800/90 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            title="User Menu"
            aria-label="User Menu"
          >
            <User size={19} />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Global hardware status strip (VRAM health + one-click release) */}
        <div className="h-11 flex-shrink-0 border-b border-slate-200/80 dark:border-slate-800/80 bg-white/70 dark:bg-[#0c1322]/70 backdrop-blur-md flex items-center justify-start px-3 sm:px-4 z-30 transition-colors duration-200">
          <VramHealthBadge />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col h-full w-full">
          <Outlet />
        </div>
      </main>
    </div>
  );
};
