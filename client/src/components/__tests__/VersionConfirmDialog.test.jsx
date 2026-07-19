import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VersionConfirmDialog from '../VersionConfirmDialog';

describe('VersionConfirmDialog (024/US2)', () => {
  function setup(props = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const utils = render(
      <VersionConfirmDialog
        isOpen
        title="Restore this version?"
        message="A new version will be created with the restored content."
        confirmLabel="Restore"
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    );
    return { onConfirm, onCancel, ...utils };
  }

  it('renders nothing when closed', () => {
    const { container } = render(
      <VersionConfirmDialog isOpen={false} onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the title and consequence message', () => {
    setup();
    expect(screen.getByText('Restore this version?')).toBeInTheDocument();
    expect(
      screen.getByText('A new version will be created with the restored content.')
    ).toBeInTheDocument();
  });

  it('performs the action only on an explicit confirm', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('dismisses via Cancel, backdrop, and Escape without confirming', () => {
    const { onConfirm, onCancel, container } = setup();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(container.querySelector('.version-dialog-overlay'));
    fireEvent.keyDown(container.querySelector('.version-dialog-overlay'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disables controls while busy', () => {
    setup({ busy: true });
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
  });

  it('surfaces an error and stays open', () => {
    setup({ error: 'Restore failed' });
    expect(screen.getByRole('alert').textContent).toBe('Restore failed');
    expect(screen.getByText('Restore this version?')).toBeInTheDocument();
  });
});
