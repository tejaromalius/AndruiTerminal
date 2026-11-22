const ENABLED_KEY = 'andrui_splash';
const SEEN_KEY = 'andrui_splash_seen';

/** The startup splash is on unless the user turned it off in Settings (stored per browser). */
export const isSplashEnabled = (): boolean => {
  try { return localStorage.getItem(ENABLED_KEY) !== 'off'; } catch { return true; }
};

export const setSplashEnabled = (enabled: boolean): void => {
  try { localStorage.setItem(ENABLED_KEY, enabled ? 'on' : 'off'); } catch { /* storage unavailable */ }
};

/** Shown once per browser tab: reloads and later visits in the same tab skip it. */
export const shouldShowSplash = (): boolean => {
  if (!isSplashEnabled()) return false;
  if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try { return sessionStorage.getItem(SEEN_KEY) !== '1'; } catch { return true; }
};

export const markSplashSeen = (): void => {
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* storage unavailable */ }
};
