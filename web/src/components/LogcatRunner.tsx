import React from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { startLogcatRunner } from '../lib/logcatRunner.js';

/** Event that opens the Logcat Runner easter egg (fired after tapping the sidebar version ten times). */
export const LOGCAT_RUNNER_EVENT = 'andrui:logcat-runner';

/** Hidden endless runner; plays entirely in the browser and never touches a device or the backend. */
export const LogcatRunner: React.FC = () => {
  const [open, setOpen] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled !== false;

  React.useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(LOGCAT_RUNNER_EVENT, show);
    return () => window.removeEventListener(LOGCAT_RUNNER_EVENT, show);
  }, []);

  const toggleFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => {});
    } else {
      void boxRef.current?.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const close = React.useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    setOpen(false);
  }, []);

  React.useEffect(() => {
    if (!open || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const runner = startLogcatRunner(canvas);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => runner.resize());
    observer?.observe(canvas);
    const onFullscreenChange = () => { setFullscreen(!!document.fullscreenElement); runner.resize(); };
    const onKeyDown = (e: KeyboardEvent) => {
      // While fullscreen, Escape only leaves fullscreen (the browser handles it); otherwise it closes the game.
      if (e.key === 'Escape' && !document.fullscreenElement) close();
      else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      runner.destroy();
      observer?.disconnect();
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, toggleFullscreen]);

  if (!open) return null;

  // Space would re-click a focused button; the game owns the keyboard.
  const blurAfter = (action: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.blur(); action(); };

  return (
    <div className="logcat-runner-overlay" role="dialog" aria-modal="true" aria-label="Logcat Runner">
      <div className={`logcat-runner-box ${fullscreen ? 'is-fullscreen' : ''}`} ref={boxRef}>
        <div className="logcat-runner-header">
          <strong>Logcat Runner</strong>
          <span className="logcat-runner-hint">Space/↑ jump (again in air = double) · ↓ duck · P pause · M mute · F fullscreen · Esc close</span>
          {canFullscreen && (
            <button className="btn btn-ghost btn-sm" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} onClick={blurAfter(toggleFullscreen)}>
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" aria-label="Close Logcat Runner" title="Close (Esc)" onClick={blurAfter(close)}><X size={14} /></button>
        </div>
        <canvas ref={canvasRef} className="logcat-runner-canvas" width={720} height={280} aria-label="Logcat Runner game" />
        <div className="logcat-runner-legend">
          <span><i style={{ background: '#f85149' }} />E/ error: jump</span>
          <span><i style={{ background: '#d29922' }} />W/ flying: duck</span>
          <span><i style={{ background: '#ff7b72' }} />F/ tall: double jump</span>
          <span><i style={{ background: '#3fb950', borderRadius: 6 }} />coin: chain for combo</span>
          <span><i style={{ background: '#d2a8ff' }} />SHIELD</span>
          <span><i style={{ background: '#58a6ff' }} />MAGNET</span>
          <span><i style={{ background: '#39d0c8' }} />SLOW-MO</span>
        </div>
      </div>
    </div>
  );
};
