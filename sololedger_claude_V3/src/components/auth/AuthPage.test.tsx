import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthPage } from './AuthPage';

const login = vi.fn(async () => {});
const register = vi.fn(async () => {});

vi.mock('@/lib/saas/authContext', () => ({
  useAuth: () => ({ login, register })
}));

describe('AuthPage', () => {
  beforeEach(() => {
    login.mockClear();
    register.mockClear();
  });

  it('login mode: password field has a working reveal toggle and no confirm-password field', () => {
    render(<AuthPage initialMode="login" />);

    // No confirm-password field in login mode.
    expect(screen.queryByPlaceholderText('Re-enter your password')).toBeNull();

    const password = screen.getByPlaceholderText('At least 8 characters') as HTMLInputElement;
    expect(password.type).toBe('password');

    // Clicking the reveal toggle flips the input to text, then back.
    const toggle = screen.getByRole('button', { name: 'Show password' });
    fireEvent.click(toggle);
    expect(password.type).toBe('text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password.type).toBe('password');
  });

  it('register mode: renders a confirm-password field with its own reveal toggle', () => {
    render(<AuthPage initialMode="register" />);
    expect(screen.getByPlaceholderText('At least 8 characters')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Re-enter your password')).toBeInTheDocument();
    // Two independent reveal toggles (password + confirm).
    expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(2);
  });

  it('register mode: blocks submit and shows an error when passwords do not match', async () => {
    render(<AuthPage initialMode="register" />);
    fireEvent.change(screen.getByPlaceholderText('you@email.com'), {
      target: { value: 'user@example.com' }
    });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'password123' }
    });
    fireEvent.change(screen.getByPlaceholderText('Re-enter your password'), {
      target: { value: 'password999' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create free account' }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('register mode: submits when passwords match', async () => {
    render(<AuthPage initialMode="register" />);
    fireEvent.change(screen.getByPlaceholderText('you@email.com'), {
      target: { value: 'user@example.com' }
    });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'password123' }
    });
    fireEvent.change(screen.getByPlaceholderText('Re-enter your password'), {
      target: { value: 'password123' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create free account' }));

    await waitFor(() => expect(register).toHaveBeenCalledWith('user@example.com', 'password123'));
  });
});
