import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AndroidDrop, ANDROID_DROP_EVENT } from '../components/AndroidDrop.js';

describe('AndroidDrop', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the Android on the event, animates it, and removes it when the animation finishes', async () => {
    const finishers: (() => void)[] = [];
    const animate = vi.fn(() => ({ finished: new Promise<void>(resolve => { finishers.push(resolve); }), cancel: vi.fn() }));
    Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true });
    render(<AndroidDrop />);
    expect(screen.queryByTestId('android-drop')).toBeNull();
    act(() => { window.dispatchEvent(new Event(ANDROID_DROP_EVENT)); });
    expect(screen.getByTestId('android-drop')).toBeTruthy();
    expect(animate).toHaveBeenCalledTimes(3); // dim, android, waving arm
    // A second click while it is playing does not start another one.
    act(() => { window.dispatchEvent(new Event(ANDROID_DROP_EVENT)); });
    expect(animate).toHaveBeenCalledTimes(3);
    await act(async () => { finishers.forEach(f => f()); });
    expect(screen.queryByTestId('android-drop')).toBeNull();
  });
});
