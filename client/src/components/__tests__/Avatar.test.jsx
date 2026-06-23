import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Avatar from '../Avatar';

describe('Avatar', () => {
  it('renders the picture when one is provided', () => {
    render(<Avatar picture="https://lh3.googleusercontent.com/a/abc" name="Phoebe Saru" className="admin-avatar" />);
    const img = screen.getByRole('img', { hidden: true });
    expect(img).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/abc');
    expect(img).toHaveClass('admin-avatar');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('falls back to the initial monogram when there is no picture', () => {
    render(<Avatar picture={null} name="Phoebe Saru" className="admin-avatar" />);
    expect(screen.queryByRole('img', { hidden: true })).toBeNull();
    const monogram = screen.getByText('P');
    expect(monogram).toHaveClass('avatar-initials');
    expect(monogram).toHaveClass('admin-avatar');
  });

  it('falls back to the monogram when the image fails to load', () => {
    render(<Avatar picture="https://lh3.googleusercontent.com/a/broken" name="Husnain Arshad" />);
    const img = screen.getByRole('img', { hidden: true });
    fireEvent.error(img);
    expect(screen.queryByRole('img', { hidden: true })).toBeNull();
    expect(screen.getByText('H')).toBeInTheDocument();
  });

  it('shows a question mark when there is neither a picture nor a name', () => {
    render(<Avatar picture={null} name={null} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});
