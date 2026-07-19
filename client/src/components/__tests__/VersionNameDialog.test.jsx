import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VersionNameDialog from '../VersionNameDialog';

describe('VersionNameDialog (024/US2)', () => {
  function setup(props = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const utils = render(
      <VersionNameDialog
        isOpen
        mode="name"
        initialValue=""
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    );
    return { onConfirm, onCancel, ...utils };
  }

  it('renders nothing when closed', () => {
    const { container } = render(
      <VersionNameDialog isOpen={false} onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('pre-fills the input in rename mode', () => {
    setup({ mode: 'rename', initialValue: 'Draft v2' });
    expect(screen.getByRole('textbox').value).toBe('Draft v2');
    expect(screen.getByText('Rename version')).toBeInTheDocument();
  });

  it('disables confirm for empty and whitespace-only input', () => {
    setup();
    const confirm = screen.getByRole('button', { name: /save/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Milestone' } });
    expect(confirm).not.toBeDisabled();
  });

  it('submits the trimmed value on confirm', () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Milestone  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onConfirm).toHaveBeenCalledWith('Milestone');
  });

  it('submits on Enter when enabled', () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ship it' } });
    fireEvent.submit(screen.getByRole('textbox').closest('form'));
    expect(onConfirm).toHaveBeenCalledWith('Ship it');
  });

  it('dismisses via Cancel, backdrop, and Escape without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container, rerender } = render(
      <VersionNameDialog isOpen mode="name" onConfirm={onConfirm} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Backdrop click (overlay is the outermost element).
    fireEvent.click(container.querySelector('.version-dialog-overlay'));
    expect(onCancel).toHaveBeenCalledTimes(2);

    // Escape.
    fireEvent.keyDown(container.querySelector('.version-dialog-overlay'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(3);

    expect(onConfirm).not.toHaveBeenCalled();
    rerender(<VersionNameDialog isOpen={false} onConfirm={onConfirm} onCancel={onCancel} />);
  });

  it('keeps the dialog open and shows the error when error is set', () => {
    setup({ error: 'Network error' });
    expect(screen.getByRole('alert').textContent).toBe('Network error');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('disables controls while busy', () => {
    setup({ busy: true });
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  });
});
