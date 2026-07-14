/**
 * FR-030 (feature 007, US5 / T033): the user profile menu carries a
 * "Documentation" item near "Get Support" that opens /documentation in a new
 * tab. Renders UserProfileBadge, opens the menu, and asserts the link's
 * target, rel, and href.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserProfileBadge from '../components/UserProfileBadge';
import { ThemeProvider } from '../contexts/ThemeContext';

const user = { name: 'Test User', email: 'test@example.com', picture: null };

async function openMenu() {
  const utils = render(
    <ThemeProvider>
      <UserProfileBadge
        user={user}
        onLogout={vi.fn()}
        onNavigateToSettings={vi.fn()}
        onNavigateToSupport={vi.fn()}
      />
    </ThemeProvider>
  );
  await userEvent.click(utils.container.querySelector('.user-profile-trigger'));
  return utils;
}

describe('user menu Documentation item (FR-030)', () => {
  it('renders a Documentation link to /documentation opening in a new tab', async () => {
    await openMenu();
    const link = screen.getByRole('link', { name: /documentation/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/documentation');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
    expect(link.className).toContain('user-menu-item');
  });

  it('sits in the menu alongside Get Support', async () => {
    await openMenu();
    const menu = document.querySelector('.user-menu');
    const items = Array.from(menu.querySelectorAll('.user-menu-item')).map((el) =>
      el.textContent.trim()
    );
    const supportIdx = items.findIndex((t) => /get support/i.test(t));
    const documentationIdx = items.findIndex((t) => /documentation/i.test(t));
    expect(supportIdx).toBeGreaterThanOrEqual(0);
    expect(documentationIdx).toBeGreaterThanOrEqual(0);
    // Adjacent to Get Support per the design (next to it in the menu).
    expect(Math.abs(documentationIdx - supportIdx)).toBe(1);
  });
});
