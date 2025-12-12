import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import './LoginPage.css';

/**
 * Login page component for HeroDocs
 * Displays branding and Google sign-in button
 */
export default function LoginPage({ onNavigateToLanding }) {
  const { login, error, loading } = useAuth();

  // Map error codes to user-friendly messages
  const getErrorMessage = (error) => {
    const errorMessages = {
      'access_denied': 'Access was denied. Please try again.',
      'config_error': 'Authentication is not configured. Please contact support.',
      'no_code': 'Authentication failed. Please try again.',
      'auth_failed': 'Authentication failed. Please try again.',
    };
    return errorMessages[error] || `Authentication error: ${error}`;
  };

  const handleLogoClick = (e) => {
    e.preventDefault();
    if (onNavigateToLanding) {
      onNavigateToLanding();
    } else {
      window.location.href = '/';
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-branding">
          <a href="/" onClick={handleLogoClick} className="login-logo-link">
            <div className="login-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M12 18v-6" />
                <path d="M9 15l3 3 3-3" />
              </svg>
            </div>
            <h1 className="login-title">HeroDocs</h1>
          </a>
          <p className="login-subtitle">AI-Native Collaborative Documents</p>
        </div>

        <h2 className="login-headline">Welcome Back</h2>

        {error && (
          <div className="login-error">
            {getErrorMessage(error)}
          </div>
        )}

        <button
          className="login-button google-button"
          onClick={login}
          disabled={loading}
        >
          <svg className="google-icon" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          <span>{loading ? 'Signing in...' : 'Continue with Google'}</span>
        </button>

        <div className="login-footer">
          <span>Don't have an account?</span>
          <a href="/" onClick={handleLogoClick} className="login-waitlist-link">
            Join the Waitlist
          </a>
        </div>
      </div>
    </div>
  );
}
