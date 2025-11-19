import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConnectionStatus from '../ConnectionStatus';

describe('ConnectionStatus', () => {
  it('renders connected state correctly', () => {
    render(<ConnectionStatus connected={true} />);
    
    const status = screen.getByText('Connected');
    expect(status).toBeInTheDocument();
    expect(status).toHaveClass('connection-status-text');
    
    const dot = status.previousElementSibling;
    expect(dot).toHaveClass('connection-status-dot');
  });

  it('renders disconnected state correctly', () => {
    render(<ConnectionStatus connected={false} />);
    
    const status = screen.getByText('Disconnected');
    expect(status).toBeInTheDocument();
    expect(status.closest('.connection-status')).toHaveClass('disconnected');
  });

  it('applies correct CSS classes for connected state', () => {
    const { container } = render(<ConnectionStatus connected={true} />);
    const statusContainer = container.querySelector('.connection-status');
    
    expect(statusContainer).toHaveClass('connected');
    expect(statusContainer).not.toHaveClass('disconnected');
  });

  it('applies correct CSS classes for disconnected state', () => {
    const { container } = render(<ConnectionStatus connected={false} />);
    const statusContainer = container.querySelector('.connection-status');
    
    expect(statusContainer).toHaveClass('disconnected');
    expect(statusContainer).not.toHaveClass('connected');
  });
});

