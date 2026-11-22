import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LogcatRunner, LOGCAT_RUNNER_EVENT } from '../components/LogcatRunner.js';

const handle = { resize: vi.fn(), pause: vi.fn(), destroy: vi.fn() };
vi.mock('../lib/logcatRunner.js', () => ({ startLogcatRunner: vi.fn(() => handle) }));

const open = () => act(() => { window.dispatchEvent(new Event(LOGCAT_RUNNER_EVENT)); });

describe('LogcatRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
  });

  it('stays hidden until the easter egg event fires, then opens and stops the game on close', () => {
    render(<LogcatRunner />);
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    expect(screen.getByRole('dialog', { name: 'Logcat Runner' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Logcat Runner' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(handle.destroy).toHaveBeenCalled();
  });

  it('closes with Escape when not fullscreen', () => {
    render(<LogcatRunner />);
    open();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requests fullscreen on the game container from the button and the F key', () => {
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { value: request, configurable: true });
    render(<LogcatRunner />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));
    fireEvent.keyDown(window, { key: 'f' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
