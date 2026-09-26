import React, { useEffect } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastProps {
  id: string;
  message: string;
  type: ToastType;
  onClose: (id: string) => void;
}

export const Toast: React.FC<ToastProps> = ({ id, message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose(id);
    }, 5000); // Auto close after 5s

    return () => clearTimeout(timer);
  }, [id, onClose]);

  const styles = {
    success: 'bg-white/95 dark:bg-slate-900/95 border-emerald-500/40 text-emerald-900 dark:text-emerald-100 shadow-emerald-500/10',
    error: 'bg-white/95 dark:bg-slate-900/95 border-rose-500/40 text-rose-900 dark:text-rose-100 shadow-rose-500/10',
    info: 'bg-white/95 dark:bg-slate-900/95 border-indigo-500/40 text-indigo-900 dark:text-indigo-100 shadow-indigo-500/10'
  };

  const icons = {
    success: <CheckCircle className="text-emerald-500 flex-shrink-0" size={20} />,
    error: <AlertCircle className="text-rose-500 flex-shrink-0" size={20} />,
    info: <Info className="text-indigo-500 flex-shrink-0" size={20} />
  };

  return (
    <div className={`
      flex items-start gap-3 p-4 rounded-xl border shadow-xl backdrop-blur-md min-w-[320px] max-w-md
      animate-in slide-in-from-right-full duration-300 pointer-events-auto
      ${styles[type]}
    `}>
      <div className="mt-0.5 flex-shrink-0">{icons[type]}</div>
      <div className="flex-1 text-sm font-medium leading-relaxed">{message}</div>
      <button 
        onClick={() => onClose(id)} 
        className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors p-0.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <X size={16} />
      </button>
    </div>
  );
};