import React from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { AndruiGlyph, ANTENNA_WIGGLE_EVENT } from './AndruiGlyph.js';
import { markSplashSeen, shouldShowSplash } from '../lib/splash.js';

const TOTAL_MS = 5500;
const FADE_MS = 250;

interface BootStep {
  text: string;
  delayMs: number;
}

/** Boot overlay shown once per tab; its lines report what the backend actually returned. */
export const SplashScreen: React.FC = () => {
  const { health, capabilities } = useWorkstation();
  const [visible, setVisible] = React.useState(shouldShowSplash);
  const [leaving, setLeaving] = React.useState(false);
  const [stepIndex, setStepIndex] = React.useState(1);
  const [progress, setProgress] = React.useState(0);

  const dismiss = React.useCallback(() => setLeaving(true), []);

  const versionText = health
    ? `andrui-terminal v${health.version} (${health.mode})`
    : 'connecting to backend…';
  const adbText = capabilities?.adbVersion || 'Android Debug Bridge 34.0.4';

  const steps: BootStep[] = React.useMemo(
    () => [
      { text: '$ andrui-terminal serve', delayMs: 0 },
      { text: versionText, delayMs: 0 },
      { text: '[  OK  ] Core daemon & loopback security initialized', delayMs: 900 },
      { text: `[  OK  ] ADB toolchain verified (${adbText})`, delayMs: 1800 },
      { text: '[  OK  ] Transport discovery active (USB / TCP / mDNS)', delayMs: 2700 },
      { text: '[  OK  ] Security boundary & agent approvals online', delayMs: 3600 },
      { text: '[  OK  ] Automation helper & screen pipeline ready', delayMs: 4400 },
      { text: '[  OK  ] Workstation ready. Opening dashboard...', delayMs: 5000 },
    ],
    [versionText, adbText]
  );

  // Stepped boot line reveal
  React.useEffect(() => {
    if (!visible) return;
    const timers: number[] = [];
    steps.forEach((step, idx) => {
      if (step.delayMs > 0) {
        const t = window.setTimeout(() => {
          setStepIndex((cur) => Math.max(cur, idx));
        }, step.delayMs);
        timers.push(t);
      }
    });
    return () => timers.forEach(window.clearTimeout);
  }, [visible, steps]);

  // Smooth progress bar update over TOTAL_MS
  React.useEffect(() => {
    if (!visible) return;
    const startTime = performance.now();
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - startTime;
      const pct = Math.min(100, Math.round((elapsed / (TOTAL_MS - 400)) * 100));
      setProgress(pct);
      if (pct >= 100) {
        window.clearInterval(interval);
      }
    }, 50);
    return () => window.clearInterval(interval);
  }, [visible]);

  // Cap at TOTAL_MS and handle keydown / click
  React.useEffect(() => {
    if (!visible) return;
    markSplashSeen();
    const cap = window.setTimeout(dismiss, TOTAL_MS);
    window.addEventListener('keydown', dismiss);
    return () => {
      window.clearTimeout(cap);
      window.removeEventListener('keydown', dismiss);
    };
  }, [visible, dismiss]);

  // Antenna wiggle & fade out on dismiss
  React.useEffect(() => {
    if (!leaving) return;
    window.dispatchEvent(new Event(ANTENNA_WIGGLE_EVENT));
    const gone = window.setTimeout(() => setVisible(false), FADE_MS);
    return () => window.clearTimeout(gone);
  }, [leaving]);

  if (!visible) return null;

  const visibleSteps = steps.slice(0, stepIndex + 1);

  return (
    <div
      className={`splash-screen ${leaving ? 'leaving' : ''}`}
      role="status"
      aria-label="Starting AndruiTerminal"
      onClick={dismiss}
    >
      <div className="splash-glyph">
        <AndruiGlyph />
      </div>

      <div className="splash-terminal-card">
        <div className="splash-scanline" />
        <div className="splash-terminal-header">
          <div className="splash-terminal-dots">
            <span className="dot dot-red" />
            <span className="dot dot-yellow" />
            <span className="dot dot-green" />
          </div>
          <span className="splash-terminal-title">andrui-terminal — boot sequence</span>
        </div>

        <pre className="splash-log">
          {visibleSteps.map((s, i) => {
            const isOk = s.text.startsWith('[  OK  ]');
            return (
              <span key={i} className="splash-log-line">
                {isOk ? (
                  <>
                    <span className="splash-ok">[  OK  ]</span>
                    <span>{s.text.slice(8)}</span>
                  </>
                ) : (
                  s.text
                )}
              </span>
            );
          })}
          <span className="splash-cursor-line">
            <span className="splash-cursor" />
          </span>
        </pre>

        <div className="splash-progress-track">
          <div className="splash-progress-bar" style={{ width: `${progress}%` }} />
        </div>
        <div className="splash-progress-info">
          <span className="splash-status-text">
            {progress < 100 ? 'Booting Linux Android workstation…' : 'All systems ready'}
          </span>
          <span className="splash-percent font-mono">{progress}%</span>
        </div>
      </div>

      <span className="splash-skip-hint">Press any key or click to skip</span>
    </div>
  );
};
