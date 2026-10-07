/**
 * Feature 059 (T003, SC-003): the team-mode, Google-only sign-in page and the
 * unauthenticated consent page must render the same visible text and the same
 * interactive controls as before 059 made them provider-driven.
 *
 * The snapshots in __snapshots__/LoginPage.baseline.test.jsx.snap were recorded
 * against the pre-059 components and committed with this test. Later changes
 * must keep this test green WITHOUT updating the snapshot file. The test waits
 * for the Google control to appear, so it holds both for the old synchronous
 * render and for the provider-driven render (which shows the action once
 * GET /auth/providers settles; the test setup mocks it with the team response).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage from '../LoginPage';
import { FirstRunConsent } from '../../pages/AuthorizePage';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn(), error: null, loading: false }),
}));
vi.mock('../Logo', () => ({ default: () => <div data-testid="logo" /> }));

function visibleText(container) {
  return container.textContent.replace(/\s+/g, ' ').trim();
}

function controls(container) {
  return Array.from(container.querySelectorAll('a, button, input, select, textarea')).map((el) => ({
    role: el.tagName.toLowerCase() === 'a' ? 'link' : el.tagName.toLowerCase(),
    name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim(),
    href: el.getAttribute('href'),
  }));
}

describe('SC-003 baseline: team mode with Google only', () => {
  it('/login', async () => {
    const { container } = render(<LoginPage mode="login" />);
    await screen.findByRole('button', { name: /sign in with google/i });
    expect({ text: visibleText(container), controls: controls(container) }).toMatchSnapshot();
  });

  it('/signup', async () => {
    const { container } = render(<LoginPage mode="signup" />);
    await screen.findByRole('button', { name: /sign up with google/i });
    expect({ text: visibleText(container), controls: controls(container) }).toMatchSnapshot();
  });

  it('consent page, read and write scopes', async () => {
    const { container } = render(
      <FirstRunConsent agentName="Claude Code" scopes={['documents:read', 'documents:write']} />,
    );
    await screen.findByRole('link', { name: /continue with google/i });
    expect({ text: visibleText(container), controls: controls(container) }).toMatchSnapshot();
  });

  it('consent page, read scope only', async () => {
    const { container } = render(
      <FirstRunConsent agentName="Claude Code" scopes={['documents:read']} />,
    );
    await screen.findByRole('link', { name: /continue with google/i });
    expect({ text: visibleText(container), controls: controls(container) }).toMatchSnapshot();
  });
});
