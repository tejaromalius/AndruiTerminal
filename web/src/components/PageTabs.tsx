import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PageId } from '../types/api.js';

const storageKey = (page: PageId) => `andrui_subtab_${page}`;
const eventName = 'andrui-subtab';

export function getPageTab(page: PageId, fallback = 'workspace') {
  try { return sessionStorage.getItem(storageKey(page)) || fallback; } catch { return fallback; }
}

export function selectPageTab(page: PageId, tab: string) {
  try { sessionStorage.setItem(storageKey(page), tab); } catch { /* Storage may be disabled. */ }
  window.dispatchEvent(new CustomEvent(eventName, { detail: { page, tab } }));
}

export function usePageTab(page: PageId, fallback: string) {
  const [activeTab, setActiveTab] = useState(() => getPageTab(page, fallback));
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ page: PageId; tab: string }>).detail;
      if (detail.page === page) setActiveTab(detail.tab);
    };
    window.addEventListener(eventName, receive);
    return () => window.removeEventListener(eventName, receive);
  }, [page]);
  return [activeTab, (tab: string) => { setActiveTab(tab); selectPageTab(page, tab); }] as const;
}

interface PageTab { id: string; label: string; content: React.ReactNode }

export function PageTabs({ page, value, onChange, tabs }: {
  page: PageId; value: string; onChange: (tab: string) => void; tabs: PageTab[];
}) {
  const active = tabs.some(tab => tab.id === value) ? value : tabs[0].id;
  useEffect(() => {
    if (active !== value) onChange(active);
  }, [active, value, onChange]);
  const visited = useRef(new Set<string>());
  visited.current.add(active);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setNavigationHost(document.getElementById(`sidebar-sections-${page}`));
  }, [page]);
  const navigationTabs = tabs.filter(tab => tab.id !== 'workspace');
  const navigation = navigationTabs.length > 0 ? <div className="page-tab-list" role="tablist" aria-orientation="vertical" aria-label={`${page} sections`}>
    {navigationTabs.map((tab, index) => <button key={tab.id} type="button" role="tab"
      id={`${page}-tab-${tab.id}`} aria-controls={`${page}-panel-${tab.id}`}
      aria-selected={active === tab.id} tabIndex={active === tab.id || navigationTabs.length === 1 ? 0 : -1}
      ref={node => { buttons.current[index] = node; }}
      onClick={() => { onChange(tab.id); window.dispatchEvent(new Event('andrui-section-chosen')); }}
      onKeyDown={event => {
        let next = index;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % navigationTabs.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + navigationTabs.length) % navigationTabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = navigationTabs.length - 1;
        else return;
        event.preventDefault();
        onChange(navigationTabs[next].id);
        buttons.current[next]?.focus();
        buttons.current[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }}>{tab.label}</button>)}
  </div> : null;
  return <div className="page-tabs">
    {navigationHost ? createPortal(navigation, navigationHost) : navigation}
    {tabs.map(tab => <section key={tab.id} role={tab.id === 'workspace' ? 'region' : 'tabpanel'} id={`${page}-panel-${tab.id}`}
      aria-labelledby={tab.id !== 'workspace' ? `${page}-tab-${tab.id}` : undefined} aria-label={tab.id === 'workspace' ? tab.label : undefined} hidden={active !== tab.id} tabIndex={0}
      className="page-tab-panel">
      {visited.current.has(tab.id) ? tab.content : null}
    </section>)}
  </div>;
}
