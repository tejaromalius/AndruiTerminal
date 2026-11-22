import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SplashScreen } from '../components/SplashScreen.js';
import { isSplashEnabled, setSplashEnabled } from '../lib/splash.js';

vi.mock('../context/WorkstationContext.js', () => ({
  useWorkstation: () => ({ health: { status: 'ok', mode: 'native', version: '9.9.9' }, capabilities: null }),
}));

describe('SplashScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
  });

  it('shows backend data once per tab', () => {
    const first = render(<SplashScreen />);
    expect(screen.getByRole('status')).toHaveTextContent('andrui-terminal v9.9.9 (native)');
    expect(screen.getByText('andrui-terminal — boot sequence')).toBeTruthy();
    expect(screen.getByText('Press any key or click to skip')).toBeTruthy();
    first.unmount();
    render(<SplashScreen />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays hidden when turned off in settings', () => {
    setSplashEnabled(false);
    expect(isSplashEnabled()).toBe(false);
    render(<SplashScreen />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses when clicked', async () => {
    vi.useFakeTimers();
    render(<SplashScreen />);
    const splash = screen.getByRole('status');
    expect(splash).not.toHaveClass('leaving');

    fireEvent.click(splash);
    expect(splash).toHaveClass('leaving');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('progresses through boot sequence steps over 5+ seconds', () => {
    vi.useFakeTimers();
    render(<SplashScreen />);
    expect(screen.getByRole('status')).toHaveTextContent('andrui-terminal v9.9.9 (native)');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Core daemon & loopback security initialized');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Transport discovery active');

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    // At 5500ms, splash dismisses automatically
    expect(screen.getByRole('status')).toHaveClass('leaving');
  });
});
