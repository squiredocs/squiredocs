import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserList from '../UserList';

describe('UserList', () => {
  it('renders empty state when no users', () => {
    render(<UserList users={[]} />);
    
    expect(screen.getByText('Online Users (0)')).toBeInTheDocument();
    expect(screen.getByText('No users online')).toBeInTheDocument();
  });

  it('renders list of users', () => {
    const users = [
      { id: 1, name: 'Alice', color: '#ff0000' },
      { id: 2, name: 'Bob', color: '#00ff00' }
    ];
    
    render(<UserList users={users} />);
    
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('displays user color indicators when no picture', () => {
    const users = [
      { id: 1, name: 'Alice', color: '#ff0000' }
    ];
    
    const { container } = render(<UserList users={users} />);
    const colorDot = container.querySelector('.user-list-color');
    
    expect(colorDot).toBeInTheDocument();
    expect(colorDot).toHaveStyle({ backgroundColor: '#ff0000' });
  });

  it('displays user avatar when picture is provided', () => {
    const users = [
      { id: 1, name: 'Alice', color: '#ff0000', picture: 'https://example.com/alice.jpg' }
    ];
    
    render(<UserList users={users} />);
    
    const avatar = screen.getByRole('img', { name: 'Alice' });
    expect(avatar).toBeInTheDocument();
    expect(avatar).toHaveAttribute('src', 'https://example.com/alice.jpg');
  });

  it('handles long user names gracefully', () => {
    const users = [
      { id: 1, name: 'Very Long User Name That Might Overflow', color: '#000000' }
    ];
    
    render(<UserList users={users} />);
    expect(screen.getByText('Very Long User Name That Might Overflow')).toBeInTheDocument();
  });

  it('renders multiple users correctly', () => {
    const users = [
      { id: 1, name: 'User 1', color: '#ff0000' },
      { id: 2, name: 'User 2', color: '#00ff00' },
      { id: 3, name: 'User 3', color: '#0000ff' }
    ];
    
    render(<UserList users={users} />);
    
    users.forEach(user => {
      expect(screen.getByText(user.name)).toBeInTheDocument();
    });
  });

  it('renders mix of users with and without pictures', () => {
    const users = [
      { id: 1, name: 'Alice', color: '#ff0000', picture: 'https://example.com/alice.jpg' },
      { id: 2, name: 'Bob', color: '#00ff00' }
    ];
    
    const { container } = render(<UserList users={users} />);
    
    // Alice should have an avatar image
    expect(screen.getByRole('img', { name: 'Alice' })).toBeInTheDocument();
    
    // Bob should have a color dot
    const colorDots = container.querySelectorAll('.user-list-color');
    expect(colorDots.length).toBe(1);
  });

  it('marks current user with "(you)" label', () => {
    const users = [
      { id: 1, name: 'Alice', color: '#ff0000' },
      { id: 2, name: 'Bob', color: '#00ff00' }
    ];
    
    render(<UserList users={users} currentUserId={1} />);
    
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });
});

