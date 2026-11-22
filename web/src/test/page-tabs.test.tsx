import React, { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTabs, selectPageTab, usePageTab } from '../components/PageTabs.js';

describe('page sub-tabs', () => {
  beforeEach(() => sessionStorage.clear());

  function Workspace({ onDispose = () => { } }: { onDispose?: () => void }) {
    const [value, onChange] = usePageTab('shell', 'terminal');
    function Session() {
      useEffect(() => onDispose, []);
      return <input aria-label="Session draft" defaultValue="" />;
    }
    // Stable type keeps the resource alive when the workspace rerenders.
    const session = React.useMemo(() => <Session />, []);
    return <PageTabs page="shell" value={value} onChange={onChange} tabs={[
      { id: 'terminal', label: 'Terminal', content: session },
      { id: 'command', label: 'Command Runner', content: <input aria-label="Command draft" /> },
      { id: 'operations', label: 'Operations', content: 'Catalog' },
    ]} />;
  }

  it('keeps drafts and mounted resources while switching panels', () => {
    const dispose = vi.fn();
    const view = render(<Workspace onDispose={dispose} />);
    const input = screen.getByLabelText('Session draft');
    fireEvent.change(input, { target: { value: 'unfinished command' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Command Runner' }));
    expect(input.closest('[role="tabpanel"]')).toHaveAttribute('hidden');
    expect(dispose).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Command draft'), { target: { value: 'getprop' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
    expect(screen.getByLabelText('Session draft')).toBe(input);
    expect(input).toHaveValue('unfinished command');
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('supports keyboard navigation and remembers selection on remount', () => {
    const view = render(<Workspace />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Command Runner' })).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Command Runner' })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Operations' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Operations' })).toHaveFocus();
    view.unmount();
    render(<Workspace />);
    expect(screen.getByRole('tab', { name: 'Operations' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens shortcut destinations and recovers invalid stored selections', () => {
    sessionStorage.setItem('andrui_subtab_shell', 'removed-tab');
    render(<Workspace />);
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    expect(sessionStorage.getItem('andrui_subtab_shell')).toBe('terminal');
    act(() => selectPageTab('shell', 'command'));
    expect(screen.getByRole('tabpanel', { name: 'Command Runner' })).toBeInTheDocument();
  });

  it('exposes only Operations and retains the unified workspace while its catalog is open', () => {
    const dispose = vi.fn();
    function Tool() { useEffect(() => dispose, []); return <input aria-label="Tool draft" />; }
    function UnifiedWorkspace() {
      const [value, onChange] = usePageTab('automation', 'workspace');
      return <PageTabs page="automation" value={value} onChange={onChange} tabs={[
        { id: 'workspace', label: 'Workspace', content: <Tool /> },
        { id: 'operations', label: 'Operations', content: 'Operation catalog' },
      ]} />;
    }
    render(<UnifiedWorkspace />);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Operations']);
    expect(screen.getByRole('tab', { name: 'Operations' })).toHaveAttribute('tabindex', '0');
    const input = screen.getByLabelText('Tool draft');
    fireEvent.change(input, { target: { value: 'keep this' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Operations' }));
    expect(screen.getByRole('tabpanel', { name: 'Operations' })).toBeInTheDocument();
    expect(dispose).not.toHaveBeenCalled();
    act(() => selectPageTab('automation', 'workspace'));
    expect(screen.getByLabelText('Tool draft')).toBe(input);
    expect(input).toHaveValue('keep this');
    expect(dispose).not.toHaveBeenCalled();
  });
});
