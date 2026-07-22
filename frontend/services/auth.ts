// nova-story/frontend/services/auth.ts
export const AuthService = {
    getToken: (): string | null => {
        return localStorage.getItem('access_token');
    },

    setToken: (token: string) => {
        localStorage.setItem('access_token', token);
    },

    clearToken: () => {
        localStorage.removeItem('access_token');
    },

    redirectToLogin: () => {
        const loginUrl = (import.meta as any).env?.VITE_NEBULA_LOGIN_URL || 'https://www.chuangyi.chat/login';
        const currentUrl = window.location.href;
        // Redirect to Nebula Login with callback to current page
        window.location.href = `${loginUrl}?redirect=${encodeURIComponent(currentUrl)}`;
    },

    isAuthenticated: (): boolean => {
        const token = localStorage.getItem('access_token');
        
        // Allow Dev Mode mock token
        if (token === 'dev-mock-token') {
            return true;
        }

        // Simple check: exists and looks like a JWT (3 parts)
        return !!token && token.split('.').length === 3;
    },
    
    handleCallback: () => {
        let token: string | null = null;
        
        // 1. Check search params
        const searchParams = new URLSearchParams(window.location.search);
        token = searchParams.get('token');

        // 2. Check hash params if not found in search
        if (!token && window.location.hash.includes('?')) {
            const hashParts = window.location.hash.split('?');
            if (hashParts.length > 1) {
                const hashParams = new URLSearchParams(hashParts[1]);
                token = hashParams.get('token');
            }
        }

        if (token) {
            AuthService.setToken(token);
            
            // Clean URL
            const url = new URL(window.location.href);
            url.searchParams.delete('token');
            
            // Remove token from hash if present
            if (url.hash.includes('?')) {
                const [hashPath, hashQuery] = url.hash.split('?');
                const hashParams = new URLSearchParams(hashQuery);
                hashParams.delete('token');
                const newHashQuery = hashParams.toString();
                url.hash = newHashQuery ? `${hashPath}?${newHashQuery}` : hashPath;
            }

            window.history.replaceState({}, document.title, url.toString());
            return true;
        }
        return false;
    }
};