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
    success: 'bg-slate-900 border-green-500/50 text-green-100',
    error: 'bg-slate-900 border-red-500/50 text-red-100',
    info: 'bg-slate-900 border-indigo-500/50 text-indigo-100'
  };

  const icons = {
    success: <CheckCircle className="text-green-500" size={20} />,
    error: <AlertCircle className="text-red-500" size={20} />,
    info: <Info className="text-indigo-500" size={20} />
  };

  return (
    <div className={`
      flex items-start gap-3 p-4 rounded-lg border shadow-xl backdrop-blur-md min-w-[300px] max-w-md
      animate-in slide-in-from-right-full duration-300 pointer-events-auto
      ${styles[type]}
    `}>
      <div className="mt-0.5 flex-shrink-0">{icons[type]}</div>
      <div className="flex-1 text-sm font-medium leading-relaxed">{message}</div>
      <button 
        onClick={() => onClose(id)} 
        className="text-slate-500 hover:text-white transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
};