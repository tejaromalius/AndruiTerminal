import { QuickStats } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab, selectPageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState, useEffect, useRef } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid } from '../components/TabKpiGrid.js';
import { useDeviceStats, statsPendingReason } from '../lib/useDeviceStats.js';
import { firstLine, formatBytes, formatRate, parseFirstLine, parseShellId } from '../lib/deviceStats.js';
import {
  Terminal as TerminalIcon,
  Play,
  RotateCcw,
  Square,
  AlertCircle,
  Sliders,
  CheckCircle2,
} from 'lucide-react';

// xterm needs concrete colors, so read them from the active theme's CSS tokens.
const readTerminalTheme = () => {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: token('--terminal-bg'),
    foreground: token('--text-main'),
    cursor: token('--emerald-accent'),
    cursorAccent: token('--terminal-bg'),
    selectionBackground: token('--emerald-border'),
    red: token('--color-danger'),
    green: token('--color-success'),
    yellow: token('--color-warning'),
    blue: token('--color-info'),
    magenta: token('--color-purple'),
  };
};

export const ShellPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('shell', 'workspace');
  const {
    theme,
    selectedDeviceId,
    jobs,
    devices,
    setActivePage,
    findOperation,
    runOperation,
  } = useWorkstation();

  // Interactive Session State
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermInstance = useRef<XTerm | null>(null);
  const wsInstance = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [sessionActive, setSessionActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Terminal output accounting for the traffic KPI
  const bytesRef = useRef(0);
  const [sessionBytes, setSessionBytes] = useState(0);
  const [outputRate, setOutputRate] = useState(0);
  useEffect(() => {
    if (!sessionActive) return;
    let last = bytesRef.current;
    const timer = setInterval(() => {
      setOutputRate(bytesRef.current - last);
      setSessionBytes(bytesRef.current);
      last = bytesRef.current;
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionActive]);

  const env = useDeviceStats('shell', selectedDeviceId, 0, { enabled: activeTab !== 'operations' });
  const pending = statsPendingReason(selectedDeviceId, env);
  const shellId = parseShellId(env.stats?.sections.id?.output ?? null);
  const toybox = parseFirstLine(env.stats?.sections, 'toybox');
  const kernel = parseFirstLine(env.stats?.sections, 'kernel');
  const shellJobs = jobs.filter(
    (j) => j.deviceId === selectedDeviceId && j.operationId === 'shell.exec' && ['completed', 'failed', 'cancelled'].includes(j.status)
  );
  const shellOk = shellJobs.filter((j) => j.status === 'completed' && j.exitCode === 0).length;

  // One-shot Runner State
  const [oneShotCmd, setOneShotCmd] = useState('getprop ro.build.version.release');
  const [oneShotOutput, setOneShotOutput] = useState<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } | null>(null);
  const [oneShotLoading, setOneShotLoading] = useState(false);

  useEffect(() => {
    if (xtermInstance.current) xtermInstance.current.options.theme = readTerminalTheme();
  }, [theme]);

  const runnerRef = useRef<HTMLDivElement>(null);

  // Start interactive terminal session
  const startSession = async () => {
    if (!selectedDeviceId) return;
    setConnecting(true);
    setSessionError(null);

    // Clean up previous
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (wsInstance.current) {
      wsInstance.current.close();
      wsInstance.current = null;
    }
    if (xtermInstance.current) {
      xtermInstance.current.dispose();
      xtermInstance.current = null;
    }

    try {
      const term = new XTerm({
        cursorBlink: true,
        convertEol: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        theme: readTerminalTheme(),
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;

      if (terminalRef.current) {
        terminalRef.current.innerHTML = '';
        term.open(terminalRef.current);
        try {
          fitAddon.fit();
        } catch {
          // ignore
        }
      }
      xtermInstance.current = term;

      // Create session on server with computed or fallback dimensions
      const initialCols = term.cols > 0 ? term.cols : 80;
      const initialRows = term.rows > 0 ? term.rows : 24;
      const { id } = await api.createShell(selectedDeviceId, initialCols, initialRows);
      term.writeln(`\x1b[32m[Connected to shell session ${id} on ${selectedDeviceId}]\x1b[0m`);

      // Connect WebSocket
      const ws = new WebSocket(api.getShellWebSocketUrl(id));
      wsInstance.current = ws;

      ws.onopen = () => {
        setSessionActive(true);
        setConnecting(false);

        // Re-fit and focus once active in DOM
        requestAnimationFrame(() => {
          try {
            fitAddon.fit();
            term.focus();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          } catch {
            // ignore
          }
        });
      };

      bytesRef.current = 0;
      setSessionBytes(0);
      setOutputRate(0);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if ((msg.type === 'stdout' || msg.type === 'stderr') && typeof msg.data === 'string') {
            bytesRef.current += new TextEncoder().encode(msg.data).length;
          }
          if (msg.type === 'stdout' && typeof msg.data === 'string') {
            term.write(msg.data);
          } else if (msg.type === 'stderr' && typeof msg.data === 'string') {
            term.write(`\x1b[31m${msg.data}\x1b[0m`);
          } else if (msg.type === 'exit') {
            term.writeln(`\r\n\x1b[33m[Process exited with code ${msg.data}]\x1b[0m`);
            setSessionActive(false);
          } else if (msg.type === 'error') {
            term.writeln(`\r\n\x1b[31m[Error: ${msg.data}]\x1b[0m`);
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        term.writeln('\r\n\x1b[33m[Shell session disconnected]\x1b[0m');
        setSessionActive(false);
      };

      ws.onerror = () => {
        setSessionError('WebSocket connection error');
        setSessionActive(false);
      };

      // User typing
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Terminal container dynamic resize observation
      if (terminalRef.current && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          try {
            fitAddon.fit();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
            }
          } catch {
            // ignore
          }
        });
        ro.observe(terminalRef.current);
        resizeObserverRef.current = ro;
      }
    } catch (err: unknown) {
      setSessionError(err instanceof Error ? err.message : 'Failed to launch shell');
      setConnecting(false);
    }
  };

  const closeSession = () => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect();
      resizeObserverRef.current = null;
    }
    if (wsInstance.current) {
      try {
        wsInstance.current.send(JSON.stringify({ type: 'close' }));
      } catch {
        // ignore
      }
      wsInstance.current.close();
      wsInstance.current = null;
    }
    setSessionActive(false);
  };

  // Run One-Shot command
  const handleRunOneShot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oneShotCmd || !selectedDeviceId) return;
    setOneShotLoading(true);
    setOneShotOutput(null);

    try {
      const op = findOperation('shell.exec');
      if (!op) throw new Error('Device shell execution is unavailable');
      const pending = await runOperation(op.id, { command: oneShotCmd }, false, { showDrawer: false });
      const job = await api.waitForJob(pending.id);
      setOneShotOutput({ stdout: job.stdout, stderr: job.stderr, exitCode: job.exitCode });
    } catch (err: unknown) {
      setOneShotOutput({
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
      });
    } finally {
      setOneShotLoading(false);
    }
  };

  // Disconnect on unmount
  useEffect(() => {
    return () => {
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (wsInstance.current) wsInstance.current.close();
      if (xtermInstance.current) xtermInstance.current.dispose();
    };
  }, []);

  return (
    <div className="workspace-page">
      <PageHeader
        title="Shell & Execution Engine"
        description="Interactive PTY terminal WebSocket session, one-shot commands, and raw exec streams"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle size={16} />
            <span>
              {devices.length === 0
                ? 'No Android devices connected to host ADB.'
                : 'No device selected. Please select a target device in the top bar.'}
            </span>
          </div>
          {devices.length === 0 && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { selectPageTab('overview', 'workspace'); setActivePage('overview'); }}
            >
              Go to Overview
            </button>
          )}
        </div>
      )}

      <PageTabs page="shell" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <TabKpiGrid
            className="kpi-grid-compact"
            items={[
              {
                id: 'shell-pty-session',
                label: 'PTY Session',
                value: !selectedDeviceId ? '—' : sessionActive ? 'Connected' : connecting ? 'Connecting…' : 'Not started',
                subtext: !selectedDeviceId ? 'No device selected' : sessionActive ? 'Interactive terminal attached' : 'Launch a shell to attach',
                icon: TerminalIcon,
                badge: sessionActive ? 'Live' : undefined,
                badgeType: 'online',
                color: 'var(--emerald-accent)',
                onClick: selectedDeviceId && !sessionActive && !connecting ? () => void startSession() : undefined,
              },
              {
                id: 'shell-io-rate',
                label: 'Terminal Output',
                value: sessionActive ? formatRate(outputRate) : '—',
                subtext: sessionBytes ? `${formatBytes(sessionBytes)} received this session` : 'No terminal output yet',
                icon: Sliders,
                color: 'var(--color-info)',
              },
              {
                id: 'shell-command-results',
                label: 'One-shot Results',
                value: !selectedDeviceId ? '—' : shellJobs.length ? `${shellOk} / ${shellJobs.length}` : 'None yet',
                subtext: !selectedDeviceId ? 'No device selected' : shellJobs.length ? 'Exited with code 0' : 'shell.exec jobs for this device',
                icon: CheckCircle2,
                badge: shellJobs.length > shellOk ? `${shellJobs.length - shellOk} failed` : undefined,
                badgeType: 'warning',
                color: 'var(--color-success)',
                onClick: () => {
                  runnerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                  runnerRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
                },
              },
              {
                id: 'shell-context-uid',
                label: 'Shell Identity',
                value: pending ? '—' : shellId ? shellId.uid : 'Unavailable',
                subtext: pending ?? ([toybox, kernel ? `kernel ${kernel}` : null].filter(Boolean).join(' · ') || firstLine(env.stats?.sections.id)),
                icon: Play,
                color: 'var(--color-purple)',
              },
            ]}
          />
          <div className="execution-workspace-grid" style={{ flex: 1 }}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                overflow: 'hidden',
                flex: 1,
                minHeight: 'max(440px, calc(100vh - 330px))',
              }}
            >
              {/* Terminal Header */}
              <div
                className="flex items-center justify-between"
                style={{
                  padding: '8px 14px',
                  backgroundColor: 'var(--bg-card)',
                  borderBottom: '1px solid var(--border-card)',
                }}
              >
                <div className="flex items-center gap-2">
                  <TerminalIcon size={15} className="text-emerald" />
                  <span className="text-sm font-medium text-main">
                    Interactive PTY shell
                  </span>
                  <span
                    className={`badge ${sessionActive
                      ? 'badge-online'
                      : connecting
                        ? 'badge-warning'
                        : 'badge-neutral'
                      }`}
                  >
                    {sessionActive ? 'Active' : connecting ? 'Connecting...' : 'Disconnected'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {!sessionActive ? (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={startSession}
                      disabled={connecting || !selectedDeviceId}
                    >
                      <Play size={12} />
                      <span>Launch Shell</span>
                    </button>
                  ) : (
                    <button className="btn btn-danger btn-sm" onClick={closeSession}>
                      <Square size={12} />
                      <span>Disconnect</span>
                    </button>
                  )}

                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => xtermInstance.current?.clear()}
                  >
                    <RotateCcw size={12} />
                    <span>Clear</span>
                  </button>
                </div>
              </div>

              {/* Terminal Canvas Container */}
              <div
                style={{
                  position: 'relative',
                  minHeight: '360px',
                  flex: 1,
                  backgroundColor: 'var(--terminal-bg)',
                  overflow: 'hidden',
                }}
                onClick={() => {
                  if (sessionActive && xtermInstance.current) {
                    xtermInstance.current.focus();
                  }
                }}
              >
                <div
                  ref={terminalRef}
                  style={{
                    width: '100%',
                    height: '100%',
                    padding: '4px',
                    boxSizing: 'border-box',
                    visibility: sessionActive ? 'visible' : 'hidden',
                  }}
                />

                {!sessionActive && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '12px',
                      padding: '20px',
                      backgroundColor: 'var(--terminal-bg)',
                      textAlign: 'center',
                      zIndex: 10,
                    }}
                  >
                    <div
                      style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '8px',
                        backgroundColor: 'var(--emerald-surface)',
                        border: '1px solid var(--emerald-border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <TerminalIcon size={22} className="text-emerald" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-main">
                        {selectedDeviceId ? `Interactive Shell for ${selectedDeviceId}` : 'Target Device Required'}
                      </div>
                      <p className="text-xs text-dim mt-1">
                        {selectedDeviceId
                          ? 'Start a full interactive PTY session with bidirectional input/output and window resizing.'
                          : 'Select an active device in the header or Overview to open an interactive terminal session.'}
                      </p>
                    </div>
                    {selectedDeviceId && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={startSession}
                        disabled={connecting}
                      >
                        <Play size={13} />
                        <span>{connecting ? 'Connecting...' : 'Launch Shell Session'}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              {sessionError && (
                <div className="p-2 bg-red-950/40 text-xs font-mono text-danger border-t border-red-900">
                  {sessionError}
                </div>
              )}
            </div>
            <div className="workspace-section-stack">
              <div className="workspace-panel shell-runner-panel" ref={runnerRef}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Play size={15} className="text-emerald" />
                    <h2 className="panel-title">One-Shot Command Runner</h2>
                  </div>
                  <span className="text-xs text-dim font-mono">Executes adb shell &lt;command&gt;</span>
                </div>

                <form onSubmit={handleRunOneShot} className="flex gap-2">
                  <input
                    type="text"
                    className="input text-xs font-mono flex-1"
                    placeholder="e.g. uname -a, pm list packages -3, getprop"
                    value={oneShotCmd}
                    onChange={(e) => setOneShotCmd(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="btn btn-secondary btn-sm"
                    disabled={oneShotLoading || !oneShotCmd || !selectedDeviceId}
                  >
                    <Play size={12} />
                    <span>{oneShotLoading ? 'Running...' : 'Run Command'}</span>
                  </button>
                </form>

                <div
                    className="font-mono text-xs shell-runner-output"
                    style={{
                      backgroundColor: 'var(--terminal-bg)',
                      padding: '10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-card)',
                      overflowY: 'auto',
                    }}
                  >
                    {!oneShotOutput && <span className="text-dim">Command output appears here</span>}
                    {oneShotOutput && (<>
                    {oneShotOutput.exitCode !== undefined && (
                      <div className="text-dim mb-1">
                        Process finished with exit code {oneShotOutput.exitCode}
                      </div>
                    )}
                    {oneShotOutput.stdout && (
                      <pre className="text-emerald whitespace-pre-wrap">{oneShotOutput.stdout}</pre>
                    )}
                    {oneShotOutput.stderr && (
                      <pre className="text-danger whitespace-pre-wrap">{oneShotOutput.stderr}</pre>
                    )}
                    </>)}
                  </div>
              </div>
              <div className="stat-strip"><QuickStats items={[
                { label: 'Command status', value: oneShotLoading ? 'Running' : oneShotOutput ? 'Finished' : 'Not run' },
                { label: 'Exit code', value: oneShotOutput?.exitCode ?? '—' },
                { label: 'Output', value: oneShotOutput ? `${(oneShotOutput.stdout ?? '').length} characters` : '—' }
              ]} /></div>
            </div></div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Execution"
            coveragePrefix="E"
            title="Execution Engine Operations"
            description="One-shot shell, ABB binder services, wait-for-state, emulator console commands"
          />
        </>
      }]} />
    </div>
  );
};
