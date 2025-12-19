import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { clearYjsInstanceCache } from '../hooks/useYjs';

// API base URL - use same host in production, configured URL in development
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Check if auth bypass is enabled (development only)
const BYPASS_AUTH = import.meta.env.VITE_BYPASS_AUTH === 'true';

// Create axios instance with credentials (for cookies)
const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
});

// Context
const AuthContext = createContext(null);

/**
 * Auth Provider component
 * Manages authentication state, token refresh, and axios interceptors
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Track if we're currently refreshing to prevent multiple simultaneous refreshes
  const isRefreshing = useRef(false);
  const refreshSubscribers = useRef([]);
  // Use ref to store token so interceptor always has latest value
  const accessTokenRef = useRef(null);

  /**
   * Subscribe to token refresh
   */
  const subscribeToRefresh = useCallback((callback) => {
    refreshSubscribers.current.push(callback);
  }, []);

  /**
   * Notify all subscribers when token is refreshed
   */
  const notifyRefreshSubscribers = useCallback((token) => {
    refreshSubscribers.current.forEach(callback => callback(token));
    refreshSubscribers.current = [];
  }, []);

  /**
   * Refresh the access token using refresh token cookie
   */
  const refreshAccessToken = useCallback(async () => {
    try {
      const response = await api.post('/auth/refresh', {}, {
        timeout: 5000, // 5 second timeout to prevent hanging
      });
      const { accessToken: newToken } = response.data;
      setAccessToken(newToken);
      return newToken;
    } catch (error) {
      // Refresh failed - user needs to login again
      setAccessToken(null);
      setUser(null);
      throw error;
    }
  }, []);

  /**
   * Fetch user profile
   */
  const fetchUser = useCallback(async (token) => {
    try {
      const response = await api.get('/auth/me', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setUser(response.data);
      return response.data;
    } catch (error) {
      console.error('Failed to fetch user:', error);
      throw error;
    }
  }, []);

  /**
   * Dev login - bypass OAuth and login with test user
   * Only works when VITE_BYPASS_AUTH=true
   */
  const devLogin = useCallback(async () => {
    try {
      const response = await api.post('/auth/dev-login');
      const { accessToken: newToken, user: userData } = response.data;
      setAccessToken(newToken);
      setUser(userData);
      return true;
    } catch (error) {
      console.error('Dev login failed:', error);
      setError('Dev login failed');
      return false;
    }
  }, []);

  /**
   * Login - redirect to Google OAuth or use dev login if bypass enabled
   * Uses relative URL so it stays on the same domain/port
   */
  const login = useCallback(async () => {
    if (BYPASS_AUTH) {
      return await devLogin();
    }
    window.location.href = '/auth/google';
  }, [devLogin]);

  /**
   * Logout - call logout endpoint and clear state
   */
  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {}, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    } catch (error) {
      console.error('Logout error:', error);
    }

    // FIX 3: Clear WebSocket instance cache on logout
    clearYjsInstanceCache();

    setAccessToken(null);
    setUser(null);

    // Clear URL and redirect to login
    window.history.replaceState({}, '', '/login');
  }, [accessToken]);

  /**
   * Set up axios interceptors for automatic token attachment and refresh
   */
  useEffect(() => {
    // Request interceptor - attach access token
    const requestInterceptor = api.interceptors.request.use(
      (config) => {
        if (accessToken && !config.headers.Authorization) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor - handle 401 errors by refreshing token
    const responseInterceptor = api.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;
        
        // Don't retry refresh token requests (would cause infinite loop)
        const isRefreshRequest = originalRequest.url?.includes('/auth/refresh');
        
        // If error is 401, we haven't retried, and it's not a refresh request
        if (error.response?.status === 401 && !originalRequest._retry && !isRefreshRequest) {
          originalRequest._retry = true;
          
          // If we're already refreshing, wait for it
          if (isRefreshing.current) {
            return new Promise((resolve, reject) => {
              subscribeToRefresh((token) => {
                if (token) {
                  originalRequest.headers.Authorization = `Bearer ${token}`;
                  resolve(api(originalRequest));
                } else {
                  reject(error);
                }
              });
            });
          }
          
          isRefreshing.current = true;
          
          try {
            const newToken = await refreshAccessToken();
            isRefreshing.current = false;
            notifyRefreshSubscribers(newToken);
            
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            return api(originalRequest);
          } catch (refreshError) {
            isRefreshing.current = false;
            notifyRefreshSubscribers(null);

            // FIX 3: Clear WebSocket instance cache on auth failure
            console.warn('[AuthContext] Token refresh failed, clearing cache');
            clearYjsInstanceCache();

            // Refresh failed - clear auth state
            setAccessToken(null);
            setUser(null);
            return Promise.reject(error);
          }
        }
        
        return Promise.reject(error);
      }
    );

    return () => {
      api.interceptors.request.eject(requestInterceptor);
      api.interceptors.response.eject(responseInterceptor);
    };
  }, [accessToken, refreshAccessToken, subscribeToRefresh, notifyRefreshSubscribers]);

  /**
   * Initialize auth state on mount
   * Check URL for access token (from OAuth redirect) or try to refresh
   */
  useEffect(() => {
    let mounted = true;
    
    const initAuth = async () => {
      setLoading(true);
      setError(null);
      
      try {
        // Check URL for access token (from OAuth callback redirect)
        const urlParams = new URLSearchParams(window.location.search);
        const tokenFromUrl = urlParams.get('accessToken');
        const errorFromUrl = urlParams.get('error');
        
        if (errorFromUrl) {
          setError(errorFromUrl);
          // Clean URL
          window.history.replaceState({}, '', window.location.pathname);
          if (mounted) setLoading(false);
          return;
        }
        
        if (tokenFromUrl) {
          // Got token from OAuth redirect
          setAccessToken(tokenFromUrl);
          
          // Clean URL (remove token from address bar and history)
          window.history.replaceState({}, '', window.location.pathname);
          
          // Fetch user profile
          try {
            await fetchUser(tokenFromUrl);
          } catch (e) {
            console.error('Failed to fetch user after OAuth:', e);
          }
          if (mounted) setLoading(false);
          return;
        }
        
        // No token in URL - try to refresh from cookie
        try {
          const newToken = await refreshAccessToken();
          await fetchUser(newToken);
        } catch (refreshError) {
          // No valid session - try dev login if bypass is enabled
          if (BYPASS_AUTH) {
            try {
              await devLogin();
              if (mounted) setLoading(false);
              return;
            } catch (devLoginError) {
              console.error('Dev login failed:', devLoginError);
            }
          }
          // No valid session - user needs to login
          // This is expected for new users, not an error
          console.log('No existing session, user needs to login');
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
        if (mounted) setError('Authentication failed');
      }
      
      if (mounted) setLoading(false);
    };
    
    initAuth();
    
    return () => {
      mounted = false;
    };
  }, [devLogin, refreshAccessToken, fetchUser]); // Run once on mount

  /**
   * DEV ONLY: Force token expiration for testing
   * Clears tokens to simulate session expiration
   */
  const expireTokenForTesting = useCallback(() => {
    if (import.meta.env.DEV) {
      console.warn('[AuthContext] DEV: Manually expiring tokens');
      // FIX 3: Clear WebSocket instance cache
      clearYjsInstanceCache();
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = {
    user,
    accessToken,
    loading,
    error,
    isAuthenticated: !!user && !!accessToken,
    login,
    logout,
    api, // Export configured axios instance for other components
    // DEV ONLY: Testing utility
    expireTokenForTesting: import.meta.env.DEV ? expireTokenForTesting : undefined,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook to access auth context
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;


