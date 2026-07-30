import React, { createContext, useContext, useState, ReactNode } from 'react';
import { translations } from './locales';

type Language = 'en' | 'zh';
type Translations = typeof translations.en;

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (path: string, fallbackOrParams?: string | Record<string, string | number>, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>('zh'); // Default to Chinese

  const t = (path: string, fallbackOrParams?: string | Record<string, string | number>, extraParams?: Record<string, string | number>): string => {
    let fallback = path;
    let params: Record<string, string | number> | undefined = extraParams;

    if (typeof fallbackOrParams === 'string') {
      fallback = fallbackOrParams;
    } else if (typeof fallbackOrParams === 'object' && fallbackOrParams !== null) {
      params = fallbackOrParams;
    }

    const resolveKey = (lang: Language): string | null => {
      const keys = path.split('.');
      let value: any = translations[lang];

      for (const key of keys) {
        if (value && typeof value === 'object' && key in value) {
          value = value[key as keyof typeof value];
        } else {
          return null;
        }
      }
      return typeof value === 'string' ? value : null;
    };

    let result = resolveKey(language) || resolveKey('en') || fallback;

    if (params) {
      return Object.entries(params).reduce((acc, [key, val]) => {
        return acc.split(`{${key}}`).join(String(val));
      }, result);
    }

    return result;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
};
