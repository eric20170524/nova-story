// nova-story/frontend/services/auth.ts
export const AuthService = {
    getToken: (): string => {
        return localStorage.getItem('access_token') || 'dev-mock-token';
    },

    setToken: (token: string) => {
        localStorage.setItem('access_token', token);
    },

    clearToken: () => {
        localStorage.removeItem('access_token');
    },

    redirectToLogin: () => {
        // Standalone Mode: Set local mock token
        AuthService.setToken('dev-mock-token');
    },

    isAuthenticated: (): boolean => {
        let token = localStorage.getItem('access_token');
        if (!token) {
            token = 'dev-mock-token';
            localStorage.setItem('access_token', token);
        }
        return true;
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