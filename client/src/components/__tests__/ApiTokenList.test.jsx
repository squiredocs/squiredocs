import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApiTokenList from '../ApiTokenList';

// Mock useAuth
const mockApi = {
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ api: mockApi }),
}));

// Mock clipboard API
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// Mock window.confirm
global.confirm = vi.fn(() => true);

describe('ApiTokenList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    mockApi.get.mockReturnValue(new Promise(() => {})); // Never resolves
    render(<ApiTokenList />);
    expect(screen.getByText('Loading API tokens...')).toBeDefined();
  });

  it('renders empty state when no tokens', async () => {
    mockApi.get.mockResolvedValue({ data: { tokens: [] } });
    render(<ApiTokenList />);
    await waitFor(() => {
      expect(screen.getByText(/No API tokens yet/)).toBeDefined();
    });
  });

  it('renders token list with names, prefixes, dates', async () => {
    mockApi.get.mockResolvedValue({
      data: {
        tokens: [
          {
            id: '1',
            name: 'CLI Token',
            tokenPrefix: 'sk_sqd_abcd',
            scopes: ['documents:read', 'documents:write'],
            createdAt: new Date().toISOString(),
            lastUsedAt: new Date().toISOString(),
          },
        ],
      },
    });

    render(<ApiTokenList />);
    await waitFor(() => {
      expect(screen.getByText('CLI Token')).toBeDefined();
      expect(screen.getByText('sk_sqd_abcd...')).toBeDefined();
    });
  });

  it('shows "New Token" button', async () => {
    mockApi.get.mockResolvedValue({ data: { tokens: [] } });
    render(<ApiTokenList />);
    await waitFor(() => {
      expect(screen.getByText('+ New Token')).toBeDefined();
    });
  });

  describe('token creation', () => {
    beforeEach(() => {
      mockApi.get.mockResolvedValue({ data: { tokens: [] } });
    });

    it('opens create form when button clicked', async () => {
      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));

      expect(screen.getByPlaceholderText(/Token name/)).toBeDefined();
    });

    it('submits form and shows token reveal', async () => {
      mockApi.post.mockResolvedValue({
        data: {
          token: 'sk_sqd_fulltoken1234567890abcdefghij12345678',
          id: 'new-id',
          name: 'New Token',
          tokenPrefix: 'sk_sqd_full',
          scopes: ['documents:read', 'documents:write'],
          createdAt: new Date().toISOString(),
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));
      fireEvent.change(screen.getByPlaceholderText(/Token name/), {
        target: { value: 'New Token' },
      });
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        expect(screen.getByText("Copy this token now — you won't be able to see it again.")).toBeDefined();
        expect(screen.getByText('sk_sqd_fulltoken1234567890abcdefghij12345678')).toBeDefined();
      });
    });

    it('token reveal shows full token in monospace', async () => {
      mockApi.post.mockResolvedValue({
        data: {
          token: 'sk_sqd_mono1234567890abcdefghij1234567890ab',
          id: 'mono-id',
          name: 'Mono Token',
          tokenPrefix: 'sk_sqd_mono',
          scopes: ['documents:read', 'documents:write'],
          createdAt: new Date().toISOString(),
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));
      fireEvent.change(screen.getByPlaceholderText(/Token name/), {
        target: { value: 'Mono Token' },
      });
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        const tokenEl = screen.getByText('sk_sqd_mono1234567890abcdefghij1234567890ab');
        expect(tokenEl.tagName.toLowerCase()).toBe('code');
      });
    });

    it('copy button calls navigator.clipboard.writeText', async () => {
      mockApi.post.mockResolvedValue({
        data: {
          token: 'sk_sqd_copy1234567890abcdefghij1234567890ab',
          id: 'copy-id',
          name: 'Copy Token',
          tokenPrefix: 'sk_sqd_copy',
          scopes: ['documents:read', 'documents:write'],
          createdAt: new Date().toISOString(),
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));
      fireEvent.change(screen.getByPlaceholderText(/Token name/), {
        target: { value: 'Copy Token' },
      });
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => screen.getByText('Copy'));
      fireEvent.click(screen.getByText('Copy'));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'sk_sqd_copy1234567890abcdefghij1234567890ab'
      );
    });

    it('"Done" button dismisses reveal and adds token to list', async () => {
      mockApi.post.mockResolvedValue({
        data: {
          token: 'sk_sqd_done1234567890abcdefghij1234567890ab',
          id: 'done-id',
          name: 'Done Token',
          tokenPrefix: 'sk_sqd_done',
          scopes: ['documents:read', 'documents:write'],
          createdAt: new Date().toISOString(),
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));
      fireEvent.change(screen.getByPlaceholderText(/Token name/), {
        target: { value: 'Done Token' },
      });
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => screen.getByText('Done'));
      fireEvent.click(screen.getByText('Done'));

      // Reveal should be gone, token should be in list
      expect(screen.queryByText("Copy this token now")).toBeNull();
      expect(screen.getByText('Done Token')).toBeDefined();
    });

    it('disables create button while submitting', async () => {
      let resolvePost;
      mockApi.post.mockReturnValue(new Promise(resolve => { resolvePost = resolve; }));

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));
      fireEvent.change(screen.getByPlaceholderText(/Token name/), {
        target: { value: 'Slow Token' },
      });
      fireEvent.click(screen.getByText('Create'));

      expect(screen.getByText('Creating...')).toBeDefined();

      // Resolve to clean up
      resolvePost({
        data: {
          token: 'sk_sqd_slow',
          id: 'slow-id',
          name: 'Slow Token',
          tokenPrefix: 'sk_sqd_slow',
          scopes: ['documents:read', 'documents:write'],
          createdAt: new Date().toISOString(),
        },
      });
    });

    it('shows error on failed creation', async () => {
      mockApi.post.mockRejectedValue({
        response: { data: { error: 'Maximum of 25 active tokens per user' } },
      });

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('+ New Token'));

      fireEvent.click(screen.getByText('+ New Token'));
      fireEvent.change(screen.getByPlaceholderText(/Token name/), {
        target: { value: 'Failing Token' },
      });
      fireEvent.click(screen.getByText('Create'));

      await waitFor(() => {
        expect(screen.getByText('Maximum of 25 active tokens per user')).toBeDefined();
      });
    });
  });

  describe('token revocation', () => {
    it('removes token from list after successful revocation', async () => {
      mockApi.get.mockResolvedValue({
        data: {
          tokens: [
            {
              id: 'revoke-1',
              name: 'To Revoke',
              tokenPrefix: 'sk_sqd_rev1',
              scopes: ['documents:read'],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            },
          ],
        },
      });
      mockApi.delete.mockResolvedValue({ data: { success: true } });

      render(<ApiTokenList />);
      await waitFor(() => screen.getByText('To Revoke'));

      fireEvent.click(screen.getByText('Revoke'));

      await waitFor(() => {
        expect(screen.queryByText('To Revoke')).toBeNull();
      });
    });
  });

  describe('token display', () => {
    it('shows token prefix with ellipsis', async () => {
      mockApi.get.mockResolvedValue({
        data: {
          tokens: [
            {
              id: '1',
              name: 'Display Token',
              tokenPrefix: 'sk_sqd_xyz1',
              scopes: ['documents:read'],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            },
          ],
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => {
        expect(screen.getByText('sk_sqd_xyz1...')).toBeDefined();
      });
    });

    it('shows "Never used" when lastUsedAt is null', async () => {
      mockApi.get.mockResolvedValue({
        data: {
          tokens: [
            {
              id: '1',
              name: 'Unused Token',
              tokenPrefix: 'sk_sqd_unus',
              scopes: ['documents:read'],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
            },
          ],
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => {
        expect(screen.getByText('Never used')).toBeDefined();
      });
    });

    it('shows "Last used" when lastUsedAt is present', async () => {
      mockApi.get.mockResolvedValue({
        data: {
          tokens: [
            {
              id: '1',
              name: 'Used Token',
              tokenPrefix: 'sk_sqd_used',
              scopes: ['documents:read'],
              createdAt: new Date().toISOString(),
              lastUsedAt: new Date().toISOString(),
            },
          ],
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => {
        expect(screen.getByText(/Last used/)).toBeDefined();
      });
    });

    it('shows an expiry line for expiring tokens (e.g. agent-minted)', async () => {
      mockApi.get.mockResolvedValue({
        data: {
          tokens: [
            {
              id: '1',
              name: 'Minted by Claude via MCP',
              tokenPrefix: 'sk_sqd_mint',
              scopes: ['documents:read'],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
            },
          ],
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => {
        expect(screen.getByText(/Expires in \d+ minutes?/)).toBeDefined();
      });
    });

    it('shows no expiry line for non-expiring tokens', async () => {
      mockApi.get.mockResolvedValue({
        data: {
          tokens: [
            {
              id: '1',
              name: 'Permanent PAT',
              tokenPrefix: 'sk_sqd_perm',
              scopes: ['documents:read'],
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              expiresAt: null,
            },
          ],
        },
      });

      render(<ApiTokenList />);
      await waitFor(() => {
        expect(screen.getByText('Permanent PAT')).toBeDefined();
      });
      expect(screen.queryByText(/Expires/)).toBeNull();
    });
  });
});
