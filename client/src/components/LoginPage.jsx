import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import Logo from './Logo';
import './LoginPage.css';

/**
 * Login page component for Squire Docs
 * Displays branding and Google sign-in button
 */
export default function LoginPage({ onNavigateToSignup, onNavigateToLogin, mode = 'signup' }) {
  const { login, error, loading } = useAuth();

  // Feature 005-agent-onboarding: honor ?returnTo=<relative path> so the
  // consent-page → login → Google → consent-page round-trip completes with
  // the authorization parameters intact. The value is same-origin-only
  // validated server-side; here we just propagate it.
  const returnTo = new URLSearchParams(window.location.search).get('returnTo');

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

  const handleLoginClick = (e) => {
    if (shouldUseBrowserLinkBehavior(e)) {
      return;
    }
    e.preventDefault();
    if (onNavigateToLogin) {
      onNavigateToLogin();
    } else {
      window.location.href = '/login';
    }
  };

  const handleSignupClick = (e) => {
    if (shouldUseBrowserLinkBehavior(e)) {
      return;
    }
    e.preventDefault();
    if (onNavigateToSignup) {
      onNavigateToSignup();
    } else {
      window.location.href = '/signup';
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-branding">
          <a href="/signup" onClick={handleSignupClick} className="login-logo-link">
            <div className="login-logo">
              <Logo color="currentColor" />
            </div>
            <h1 className="login-title">Squire Docs</h1>
          </a>
          <p className="login-subtitle">Write with AI, right in your doc</p>
        </div>

        <h2 className="login-headline">{mode === 'login' ? 'Welcome Back' : 'Get Started'}</h2>

        {error && (
          <div className="login-error">
            {getErrorMessage(error)}
          </div>
        )}

        <button
          className="login-button google-button"
          onClick={() => login(returnTo)}
          disabled={loading}
        >
          <svg className="google-icon" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          <span>{loading ? 'Signing in...' : (mode === 'login' ? 'Sign in with Google' : 'Sign up with Google')}</span>
        </button>

        <div className="login-footer">
          {mode === 'login' ? (
            <>
              <span>Don't have an account?</span>
              <a href="/signup" onClick={handleSignupClick} className="login-signup-link">
                Sign Up
              </a>
            </>
          ) : (
            <>
              <span>Already have an account?</span>
              <a href="/login" onClick={handleLoginClick} className="login-signup-link">
                Sign In
              </a>
            </>
          )}
        </div>

        <div className="login-legal">
          <a href="/privacy" className="login-legal-link">Privacy Policy</a>
          <span className="login-legal-sep" aria-hidden="true">·</span>
          <a href="/terms" className="login-legal-link">Terms of Service</a>
        </div>
      </div>
    </div>
  );
}


