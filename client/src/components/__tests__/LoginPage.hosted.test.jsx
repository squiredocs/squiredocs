/**
 * Feature 058 (T047, FR-025): the sign-in page shows the Squire Docs privacy
 * and terms links only on the hosted service.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage from '../LoginPage';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), error: null, loading: false }),
}));
vi.mock('../Logo', () => ({ default: () => <div data-testid="logo" /> }));

describe('LoginPage legal links', () => {
  afterEach(() => {
    delete window.__SQUIRE_INSTANCE__;
  });

  it('hidden when not hosted', () => {
    render(<LoginPage />);
    expect(screen.queryByText('Privacy Policy')).toBeNull();
    expect(screen.queryByText('Terms of Service')).toBeNull();
  });

  it('shown when hosted', () => {
    window.__SQUIRE_INSTANCE__ = { hosted: true };
    render(<LoginPage />);
    expect(screen.getByText('Privacy Policy')).toHaveAttribute('href', '/privacy');
    expect(screen.getByText('Terms of Service')).toHaveAttribute('href', '/terms');
  });
});
