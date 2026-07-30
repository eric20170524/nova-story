import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { ProjectLayout } from './pages/ProjectLayout';
import { StoryEditor } from './pages/StoryEditor';
import { CharacterManager } from './pages/CharacterManager';
import { DirectorMode } from './pages/DirectorMode';
import { ProjectSettings } from './pages/ProjectSettings';
import { SettingsPage } from './pages/Settings';
import { LanguageProvider } from './LanguageContext';
import { ToastProvider } from './ToastContext';
import { AuthService } from './services/auth';

// Authentication Guard Component
const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
    const location = useLocation();

    useEffect(() => {
        // 1. Check for token in URL (Callback from Login)
        if (AuthService.handleCallback()) {
            setIsAuthenticated(true);
            return;
        }

        // 2. Check Local Storage
        if (AuthService.isAuthenticated()) {
            setIsAuthenticated(true);
        } else {
            setIsAuthenticated(false);
            // Redirect to Nebula Login
            AuthService.redirectToLogin();
        }
    }, [location]);

    if (isAuthenticated === null) {
        return <div className="flex items-center justify-center h-screen">Loading Auth...</div>;
    }

    if (!isAuthenticated) {
        return null; // Will redirect in useEffect
    }

    return <>{children}</>;
};

const App: React.FC = () => {
  return (
    <LanguageProvider>
      <ToastProvider>
        <BrowserRouter>
          <AuthGuard>
              <Routes>
              <Route path="/" element={<Layout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="settings" element={<SettingsPage />} />
                  
                  {/* Project Specific Routes */}
                  <Route path="project/:id" element={<ProjectLayout />}>
                  <Route index element={<Navigate to="story" replace />} />
                  <Route path="story" element={<StoryEditor />} />
                  <Route path="characters" element={<CharacterManager />} />
                  <Route path="director" element={<DirectorMode />} />
                  <Route path="settings" element={<ProjectSettings />} />
                  </Route>
              </Route>
              </Routes>
          </AuthGuard>
        </BrowserRouter>
      </ToastProvider>
    </LanguageProvider>
  );
};

export default App;