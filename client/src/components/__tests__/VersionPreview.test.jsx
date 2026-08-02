import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import VersionPreview from '../VersionPreview';

// TipTap is irrelevant to the state machine under test; stub it so the preview
// renders synchronously in jsdom.
vi.mock('@tiptap/react', () => ({
  useEditor: () => ({ isEditor: true }),
  EditorContent: () => <div data-testid="editor-content">Editor Content</div>,
}));

const selection = {
  id: 'v1',
  name: 'Draft',
  clockStart: 1,
  clockEnd: 5,
  timestamp: '2024-01-05T16:30:00Z',
  authors: [],
};

/**
 * Feature 041 US2 (FR-006, SC-003): a failed preview load renders an error.
 * The "Select a version to preview" placeholder describes exactly one state —
 * nothing is selected — and must never stand in for a failure.
 */
describe('VersionPreview error state (041 FR-006)', () => {
  it('renders an error state when the diff load failed, not the placeholder', () => {
    render(<VersionPreview diffData={null} diffError="diff boom" selection={selection} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Couldn't load this version's preview/i)).toBeTruthy();
    expect(screen.getByText('diff boom')).toBeTruthy();
    expect(screen.queryByText(/Select a version to preview/i)).toBeNull();
  });

  it('renders the placeholder only when nothing is selected', () => {
    render(<VersionPreview diffData={null} diffError={null} selection={null} />);

    expect(screen.getByText(/Select a version to preview/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows loading (never the placeholder) while a selection has no data yet', () => {
    render(<VersionPreview diffData={null} diffError={null} selection={selection} />);

    expect(screen.getByText(/Loading version/i)).toBeTruthy();
    expect(screen.queryByText(/Select a version to preview/i)).toBeNull();
  });

  it('renders the document once the diff arrives', () => {
    render(
      <VersionPreview
        diffData={{ document: { type: 'doc', content: [] }, meta: {} }}
        diffError={null}
        selection={selection}
      />
    );

    expect(screen.getByTestId('editor-content')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Select a version to preview/i)).toBeNull();
  });
});
