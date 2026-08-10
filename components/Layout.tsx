import React, { useState, useRef, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Home, Settings, Globe, User } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { VramHealthBadge } from './VramHealthBadge';

export const Layout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, language, setLanguage } = useLanguage();
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

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Sidebar - Compact Fixed Width */}
      <aside className="w-16 bg-slate-900 border-r border-slate-800 flex flex-col flex-shrink-0 transition-all duration-300 z-40">
        
        {/* Logo */}
        <div className="h-16 flex items-center justify-center border-b border-slate-800">
          <button
             onClick={() => navigate('/')}
             className="w-10 h-10 rounded-xl overflow-hidden shadow-lg shadow-indigo-600/25 ring-1 ring-indigo-500/40 hover:ring-indigo-400/70 hover:scale-105 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
             title="NovaStory"
             aria-label="NovaStory Home"
          >
            <img
              src="/logo-192.png"
              alt="NovaStory"
              className="w-full h-full object-cover"
              width={40}
              height={40}
              draggable={false}
            />
          </button>
        </div>

        {/* Spacer / Main Nav */}
        <nav className="flex-1 py-4 flex flex-col items-center gap-3">
          <button
             onClick={() => handleNavigation('/')}
             className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${location.pathname === '/' ? 'bg-slate-800 text-indigo-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
             title={t('app.dashboard')}
          >
             <Home size={20} />
          </button>
          <button
             onClick={() => handleNavigation('/settings')}
             className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors ${location.pathname === '/settings' ? 'bg-slate-800 text-indigo-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
             title={t('app.settings')}
          >
             <Settings size={20} />
          </button>
        </nav>

        {/* Bottom Menu Trigger */}
        <div className="p-3 border-t border-slate-800 flex flex-col items-center relative" ref={menuRef}>
          
          {/* Popup Menu */}
          {isMenuOpen && (
            <div className="absolute left-0 sm:left-full bottom-full sm:bottom-0 mb-2 sm:mb-0 sm:ml-3 w-56 sm:w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in duration-200">
               {/* User Info Header */}
               <div className="p-4 border-b border-slate-800 bg-slate-850">
                  <div className="font-medium text-white flex items-center gap-2">
                     <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs">U</div>
                     <div className="min-w-0 flex-1">
                        <div className="text-sm truncate">{t('app.director_role')}</div>
                        <div className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">{t('app.plan')}</div>
                     </div>
                  </div>
               </div>
               
               <div className="p-2 space-y-1">
                 <button 
                    onClick={() => handleNavigation('/')}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${location.pathname === '/' ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
                 >
                    <Home size={18} />
                    {t('app.dashboard')}
                 </button>

                 <button 
                    onClick={() => handleNavigation('/settings')}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${location.pathname === '/settings' ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
                 >
                    <Settings size={18} />
                    {t('app.settings')}
                 </button>

                 <div className="h-px bg-slate-800 my-1 mx-2"></div>

                 <button 
                    onClick={toggleLanguage}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                 >
                    <Globe size={18} />
                    <span>{language === 'zh' ? 'English' : '中文'}</span>
                 </button>
               </div>
            </div>
          )}

          {/* Avatar / Trigger Button */}
          <button 
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${isMenuOpen ? 'bg-indigo-600 text-white ring-2 ring-indigo-400 ring-offset-2 ring-offset-slate-900' : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'}`}
            title="Menu"
          >
            <User size={20} />
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Global hardware status strip (VRAM health + one-click release) — left so Agent OS panel won't cover it */}
        <div className="h-11 flex-shrink-0 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm flex items-center justify-start px-3 sm:px-4 z-30">
          <VramHealthBadge />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden relative">
          <Outlet />
        </div>
      </main>
    </div>
  );
};
