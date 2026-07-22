import React, { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Home, Settings, Globe, User, LogOut } from 'lucide-react';
import { useLanguage } from '../LanguageContext';

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
             className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 transition-colors"
          >
            <span className="font-bold text-white text-xl">N</span>
          </button>
        </div>

        {/* Spacer / Main Nav (Empty now as requested) */}
        <nav className="flex-1 py-6 flex flex-col items-center gap-4">
           {/* Can add quick icons here later if needed */}
        </nav>

        {/* Bottom Menu Trigger */}
        <div className="p-3 border-t border-slate-800 flex flex-col items-center relative" ref={menuRef}>
          
          {/* Popup Menu */}
          {isMenuOpen && (
            <div className="absolute left-full bottom-0 ml-3 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in slide-in-from-left-2 duration-200">
               {/* User Info Header */}
               <div className="p-4 border-b border-slate-800 bg-slate-850">
                  <div className="font-medium text-white flex items-center gap-2">
                     <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs">U</div>
                     <div>
                        <div className="text-sm">{t('app.director_role')}</div>
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
        <Outlet />
      </main>
    </div>
  );
};
