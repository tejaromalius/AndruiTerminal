import React, { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  ArrowUpRight,
  FileSearch,
  Send,
  X,
  Maximize2,
  Minimize2,
  Trash2,
} from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import type { AssistantReport, ModelProvider } from '../types/experience.js';

const PANEL_HEIGHT_KEY = 'andrui_ai_drawer_height';
const DEFAULT_PANEL_HEIGHT = 380;
const MIN_PANEL_HEIGHT = 180;
const TOOL_OUTPUT_LIMIT_KEY = 'andrui_ai_tool_output_limit';
const DEFAULT_TOOL_OUTPUT_LIMIT = 12000;
const MIN_TOOL_OUTPUT_LIMIT = 1000;
const MAX_TOOL_OUTPUT_LIMIT = 200000;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  report?: AssistantReport;
}

export const AiDrawer: React.FC = () => {
  const {
    devices,
    selectedDeviceId,
    setActivePage,
    isAiDrawerOpen,
    setIsAiDrawerOpen,
  } = useWorkstation();

  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldRender, setShouldRender] = useState(isAiDrawerOpen);
  const [isClosing, setIsClosing] = useState(false);

  const [mode, setMode] = useState<'' | 'workflow'>('');
  const [question, setQuestion] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [logs, setLogs] = useState(false);
  const [evidence, setEvidence] = useState('{}');
  const [provider, setProvider] = useState<ModelProvider | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toolOutputLimit, setToolOutputLimit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(TOOL_OUTPUT_LIMIT_KEY));
      return saved >= MIN_TOOL_OUTPUT_LIMIT ? saved : DEFAULT_TOOL_OUTPUT_LIMIT;
    } catch {
      return DEFAULT_TOOL_OUTPUT_LIMIT;
    }
  });

  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [panelSizing, setPanelSizing] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
      return {
        height: saved >= MIN_PANEL_HEIGHT ? saved : DEFAULT_PANEL_HEIGHT,
        customized: saved >= MIN_PANEL_HEIGHT,
      };
    } catch {
      return { height: DEFAULT_PANEL_HEIGHT, customized: false };
    }
  });
  const [isResizing, setIsResizing] = useState(false);

  // Slide open / close animation matching JobDrawer
  useEffect(() => {
    if (isAiDrawerOpen) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }
    if (!shouldRender) return;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    ) {
      setShouldRender(false);
      setIsClosing(false);
      return;
    }
    setIsClosing(true);
    const timer = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [isAiDrawerOpen, shouldRender]);

  // Discard evidence and conversation when selected device changes
  useEffect(() => {
    generation.current++;
    controller.current?.abort();
    setBusy(false);
    setEvidence('{}');
    setMessages([]);
    setTargets(selectedDeviceId ? [selectedDeviceId] : []);
  }, [selectedDeviceId]);

  useEffect(() => () => { controller.current?.abort(); }, []);

  // Load configured model provider when drawer opens or provider changes
  useEffect(() => {
    let active = true;
    const load = () => {
      if (isAiDrawerOpen) {
        api
          .experience<ModelProvider>('/ai/provider')
          .then((p) => {
            if (active) setProvider(p);
          })
          .catch((e) => {
            if (active) setError(String(e));
          });
      }
    };
    load();
    window.addEventListener('andrui:provider-changed', load);
    return () => {
      active = false;
      window.removeEventListener('andrui:provider-changed', load);
    };
  }, [isAiDrawerOpen]);

  // Escape collapses or closes the drawer
  useEffect(() => {
    if (!isAiDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isExpanded) {
          setIsExpanded(false);
        } else {
          setIsAiDrawerOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAiDrawerOpen, isExpanded, setIsAiDrawerOpen]);

  // Publish height CSS variable so MainContent reserves bottom padding
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--ai-drawer-height', `${panelSizing.height}px`);
    return () => {
      root.removeProperty('--ai-drawer-height');
    };
  }, [panelSizing.height]);

  // Scroll to newest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const maxPanelHeight = () =>
    panelRef.current?.parentElement?.clientHeight || window.innerHeight;

  const resizeTo = (height: number) => {
    const max = maxPanelHeight();
    if (height >= max - 8) {
      setIsExpanded(true);
      return;
    }
    const next = Math.round(Math.max(MIN_PANEL_HEIGHT, height));
    setIsExpanded(false);
    setPanelSizing({ height: next, customized: true });
    try {
      localStorage.setItem(PANEL_HEIGHT_KEY, String(next));
    } catch {
      /* storage unavailable */
    }
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startHeight = panelRef.current!.getBoundingClientRect().height;
    const startY = e.clientY;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setIsResizing(true);
    const onMove = (ev: PointerEvent) => resizeTo(startHeight + startY - ev.clientY);
    const onUp = () => {
      setIsResizing(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const current = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    try {
      await action(controller.current.signal);
    } catch (e) {
      if (
        current === generation.current &&
        !(e instanceof DOMException && e.name === 'AbortError')
      ) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  const collect = () =>
    run(async (signal) => {
      const value = await api.experience<unknown>(
        '/ai/evidence',
        'POST',
        { deviceIds: targets, includeLogs: logs },
        signal
      );
      if (!signal.aborted) {
        setEvidence(JSON.stringify({ observations: value }, null, 2));
      }
    });

  const send = () =>
    run(async (signal) => {
      const promptText = question.trim();
      if (!promptText) return;
      const historyPayload = messages
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));
      const value = await api.experience<AssistantReport>(
        '/ai/assist',
        'POST',
        {
          question: promptText,
          evidence: JSON.parse(evidence),
          confirmed: true,
          mode,
          expectedProvider: provider,
          history: historyPayload,
          toolOutputLimit,
        },
        signal
      );
      if (!signal.aborted) {
        setMessages((prev) => [
          ...prev,
          { id: `${Date.now()}-u`, role: 'user', content: promptText },
          {
            id: value.id || `${Date.now()}-a`,
            role: 'assistant',
            content: value.answer.slice(0, 16000),
            report: value,
          },
        ]);
        setQuestion('');
      }
    });

  const saveWorkflow = (workflow: AssistantReport['workflow']) =>
    run(async () => {
      if (!workflow) return;
      await api.createWorkflow(workflow);
      window.dispatchEvent(new Event('andrui:workflows-changed'));
      setError('Workflow saved. Review and run it from Automation.');
    });

  if (!shouldRender) return null;

  const hasEvidence = evidence.trim() !== '' && evidence.trim() !== '{}';
  const quickPrompts =
    mode === 'workflow'
      ? ['Capture screenshot & device info', 'Check app launch & logcat errors']
      : ['Summarize device health', 'Diagnose latest crash', 'Check battery & thermals'];
  const canSend = !busy && !!question.trim() && !!provider?.model;

  return (
    <div
      ref={panelRef}
      className={`job-drawer-container ai-drawer-container ${isResizing ? 'resizing' : ''} ${isClosing ? 'closing' : ''}`}
      style={{ height: isExpanded ? '100%' : `${panelSizing.height}px` }}
      onAnimationEnd={(e) => {
        if (isClosing && e.target === panelRef.current) {
          setShouldRender(false);
          setIsClosing(false);
        }
      }}
    >
      <div
        className="job-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize AI chat panel"
        title="Drag to resize · double-click to expand or restore"
        tabIndex={0}
        onPointerDown={handleResizeStart}
        onDoubleClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const current = isExpanded ? maxPanelHeight() : panelSizing.height;
          resizeTo(current + (e.key === 'ArrowUp' ? 40 : -40));
        }}
      />

      <div className="job-toolbar">
        <div
          className="job-toolbar-title"
          onPointerDown={handleResizeStart}
          title="Drag to resize AI chat panel"
        >
          <Sparkles size={14} className="text-emerald" />
          <span>AI Chat</span>
        </div>

        <div className="job-filters" role="group" aria-label="Assistant mode">
          <button
            type="button"
            className={`job-filter ${mode === '' ? 'active' : ''}`}
            aria-pressed={mode === ''}
            onClick={() => setMode('')}
          >
            Ask
          </button>
          <button
            type="button"
            className={`job-filter ${mode === 'workflow' ? 'active' : ''}`}
            aria-pressed={mode === 'workflow'}
            onClick={() => setMode('workflow')}
          >
            Workflow
          </button>
        </div>

        <span className="ai-drawer-provider">
          <span className={`connection-dot ${provider?.model ? 'connected' : ''}`} />
          <span>{provider?.model || 'Choose a model'}</span>
          {provider?.endpoint && (
            <span className="text-muted assistant-endpoint mobile-hide">{provider.endpoint}</span>
          )}
        </span>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setActivePage('ai');
            setIsAiDrawerOpen(false);
          }}
        >
          Model settings <ArrowUpRight size={13} />
        </button>

        <div className="job-toolbar-actions">
          {messages.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => {
                setMessages([]);
                setError('');
              }}
              title="Clear chat history"
            >
              <Trash2 size={13} />
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setIsAiDrawerOpen(false)}
            title="Close AI Chat"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="ai-drawer-body">
        <aside className="ai-drawer-evidence" aria-label="Review evidence">
          <div className="ai-drawer-section-title">
            <span>Evidence</span>
            <span className="panel-status-pill font-mono">
              {hasEvidence ? `${evidence.length} chars` : 'No evidence'}
            </span>
          </div>

          <div className="ai-drawer-targets" aria-label="Evidence devices">
            {devices.map((d) => (
              <label
                className={`assistant-target ${targets.includes(d.id) ? 'is-selected' : ''}`}
                key={d.id}
              >
                <input
                  type="checkbox"
                  checked={targets.includes(d.id)}
                  disabled={busy || d.state !== 'device'}
                  onChange={(e) => {
                    setTargets((t) =>
                      e.target.checked ? [...t, d.id] : t.filter((id) => id !== d.id)
                    );
                    setEvidence('{}');
                    setMessages([]);
                  }}
                />
                <span>
                  <span>{d.model?.replace(/_/g, ' ') || d.id}</span>
                  <small>{d.id}</small>
                </span>
              </label>
            ))}
          </div>

          <div className="widget-actions ai-drawer-collect">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy || !targets.length}
              onClick={collect}
            >
              <FileSearch size={14} />
              Collect evidence
            </button>
            <label className="widget-check">
              <input
                type="checkbox"
                checked={logs}
                disabled={busy}
                onChange={(e) => {
                  setLogs(e.target.checked);
                }}
              />
              Crash logs
            </label>
          </div>

          {mode === '' && (
            <label className="widget-field">
              <span className="text-xs text-muted">
                Tool output limit (chars per probe, ≈{Math.round(toolOutputLimit / 3)} tokens)
              </span>
              <input
                type="number"
                className="input font-mono"
                aria-label="Tool output limit"
                min={MIN_TOOL_OUTPUT_LIMIT}
                max={MAX_TOOL_OUTPUT_LIMIT}
                step={1000}
                value={toolOutputLimit}
                disabled={busy}
                title="Lower this for small-context local models; probe output beyond it is cut before sending"
                onChange={(e) => setToolOutputLimit(Number(e.target.value))}
                onBlur={() => {
                  const next = Math.min(
                    MAX_TOOL_OUTPUT_LIMIT,
                    Math.max(MIN_TOOL_OUTPUT_LIMIT, toolOutputLimit || DEFAULT_TOOL_OUTPUT_LIMIT)
                  );
                  setToolOutputLimit(next);
                  try {
                    localStorage.setItem(TOOL_OUTPUT_LIMIT_KEY, String(next));
                  } catch {
                    /* storage unavailable */
                  }
                }}
              />
            </label>
          )}

          <label className="widget-field ai-drawer-evidence-field">
            <span className="text-xs text-muted">Evidence to send (editable)</span>
            <textarea
              className="input font-mono ai-drawer-evidence-input"
              aria-label="Evidence to send"
              value={evidence}
              disabled={busy}
              onChange={(e) => {
                setEvidence(e.target.value);
              }}
            />
          </label>
        </aside>

        <section className="ai-drawer-chat" aria-label="AI conversation">
          <div className="ai-chat-messages" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="ai-chat-empty">
                <Sparkles size={20} className="text-emerald" />
                <div className="text-xs font-semibold text-main">
                  {mode === 'workflow'
                    ? 'Propose a device workflow'
                    : 'Ask about your selected device'}
                </div>
                <p className="text-xs text-dim">
                  Collect and review evidence on the left, then send your request.
                </p>
                <div className="chip-row" aria-label="Suggested prompts">
                  {quickPrompts.map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="chip-button"
                      disabled={busy}
                      onClick={() => {
                        setQuestion(item);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`ai-chat-msg ai-chat-msg-${msg.role}`}>
                  <div className="ai-chat-msg-role">
                    {msg.role === 'user' ? 'You' : msg.report?.provider.model || 'Assistant'}
                    {msg.report && (
                      <span className="text-dim"> · {msg.report.latencyMs} ms</span>
                    )}
                  </div>
                  <pre className="ai-chat-msg-text">{msg.content}</pre>
                  {msg.report && (
                    <div className="widget-actions ai-chat-msg-actions">
                      <a
                        className="btn btn-secondary btn-sm"
                        href={`/api/v1/reports/${encodeURIComponent(msg.report.id)}`}
                        download={`andrui-report-${msg.report.id}.json`}
                      >
                        Download report and evidence
                      </a>
                      {msg.report.workflow && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy}
                          onClick={() => saveWorkflow(msg.report!.workflow)}
                        >
                          Save proposed workflow
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="ai-chat-composer">
            {error && (
              <p className="widget-feedback text-warning ai-chat-error" role="status">
                {error}
              </p>
            )}
            <div className="ai-chat-input-row">
              <textarea
                className="input ai-chat-input"
                aria-label="Assistant request"
                rows={1}
                placeholder={
                  mode === 'workflow'
                    ? 'Describe a workflow using semantic selectors, waits, and assertions…'
                    : 'Ask about this device, crash logs, or shell commands…'
                }
                value={question}
                disabled={busy}
                onChange={(e) => {
                  setQuestion(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && canSend) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="ai-chat-send-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!canSend}
                  onClick={send}
                >
                  <Send size={14} />
                  {busy
                    ? 'Working…'
                    : mode === 'workflow'
                      ? 'Propose workflow'
                      : 'Ask assistant'}
                </button>
                {busy && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      generation.current++;
                      controller.current?.abort();
                      setBusy(false);
                    }}
                  >
                    Stop waiting
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
