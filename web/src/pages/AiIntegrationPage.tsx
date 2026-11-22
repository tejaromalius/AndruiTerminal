import { AiConfiguration } from '../components/AiConfiguration.js';
import { QuickStats } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Plug, BookOpen, ListChecks, RefreshCw, AlertCircle, Activity, Send, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import { ApprovalsPanel } from '../components/ApprovalsPanel.js';
import { McpAccessPanel } from '../components/McpAccessPanel.js';
import { ParamList, SeverityBadge } from '../components/ApprovalParts.js';
import type { AiStatus, Approval, McpTestResult } from '../types/api.js';

type Busy = 'status' | 'mcp' | 'skill' | 'remove-mcp' | 'remove-skill' | 'test-mcp' | 'test-approval' | null;

const QUEUE_PAGE_SIZE = 15;

const STATUS_BADGE: Record<Approval['status'], string> = {
  pending: 'badge-warning',
  approved: 'badge-success',
  not_required: 'badge-neutral',
  denied: 'badge-danger',
  expired: 'badge-neutral',
  failed: 'badge-danger',
};

const shellQuote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

function mcpState(status: AiStatus): { label: string; className: string } {
  const { mcp } = status;
  if (mcp.registered && mcp.matchesExpected) return { label: 'Installed', className: 'badge-success' };
  if (mcp.registered) return { label: 'Needs update', className: 'badge-warning' };
  return { label: 'Not installed', className: 'badge-neutral' };
}

function skillState(status: AiStatus): { label: string; className: string } {
  const { skill } = status;
  if (skill.installed && skill.upToDate) return { label: 'Installed', className: 'badge-success' };
  if (skill.installed) return { label: 'Outdated', className: 'badge-warning' };
  return { label: 'Not installed', className: 'badge-neutral' };
}

export const AiIntegrationPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('ai', 'workspace');
  const { devices, setSelectedJobId, setIsJobDrawerOpen } = useWorkstation();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [history, setHistory] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [simulatedMsg, setSimulatedMsg] = useState<string | null>(null);

  const runMcpTest = async () => {
    setBusy('test-mcp');
    setError(null);
    try {
      const res = await api.testMcp();
      setTestResult(res);
      if (!res.ok && res.error) {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const triggerTestApproval = async () => {
    setBusy('test-approval');
    setError(null);
    setSimulatedMsg(null);
    try {
      const readyDevice = devices.find((d) => d.state === 'device')?.id || devices[0]?.id;
      const approval = await api.createApproval(
        readyDevice
          ? {
              operationId: 'shell.exec',
              deviceId: readyDevice,
              parameters: { command: "echo 'MCP test approval'" },
              requester: 'mcp-test',
            }
          : {
              operationId: 'device.list',
              parameters: {},
              requester: 'mcp-test',
            }
      );
      loadHistory();
      setSimulatedMsg(
        approval.status === 'pending'
          ? `Submitted agent approval ${approval.id} (status: pending). Review and approve/deny in the execution queue below.`
          : `Submitted agent request ${approval.id} (status: ${approval.status}). Recorded in the execution queue.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const [historyPage, setHistoryPage] = useState(0);

  const totalHistoryPages = Math.max(1, Math.ceil(history.length / QUEUE_PAGE_SIZE));
  const currentHistoryPage = Math.min(historyPage, totalHistoryPages - 1);
  const visibleHistory = useMemo(
    () => history.slice(currentHistoryPage * QUEUE_PAGE_SIZE, (currentHistoryPage + 1) * QUEUE_PAGE_SIZE),
    [history, currentHistoryPage]
  );

  const deviceName = useMemo(() => {
    const names = new Map(devices.map((d) => [d.id, d.model?.replace(/_/g, ' ')]));
    return (deviceId?: string) => (deviceId ? names.get(deviceId) || deviceId : 'Host');
  }, [devices]);

  const loadStatus = useCallback(async () => {
    setBusy('status');
    try {
      setStatus(await api.getAiStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const loadHistory = useCallback(() => {
    api
      .getApprovals()
      .then(setHistory)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadStatus();
    loadHistory();
    const interval = setInterval(loadHistory, 10000);
    window.addEventListener('andrui:approval', loadHistory);
    return () => {
      clearInterval(interval);
      window.removeEventListener('andrui:approval', loadHistory);
    };
  }, [loadStatus, loadHistory]);

  const mcpCommand = status
    ? ['claude', 'mcp', 'add', '--scope', 'user', 'andrui', '--', status.mcp.expectedCommand, ...status.mcp.expectedArgs]
        .map(shellQuote)
        .join(' ')
    : '';

  const install = async (what: 'mcp' | 'skill') => {
    if (!status) return;
    const message =
      what === 'mcp'
        ? `Register AndruiTerminal with Claude Code for your user account?\n\nThis runs:\n${mcpCommand}` +
          (status.mcp.scope === 'user' ? '\n\nThe existing user-scope "andrui" entry is removed first.' : '')
        : `Write the AndruiTerminal skill to:\n${status.skill.path}` +
          (status.skill.installed ? '\n\nThe existing file is replaced.' : '');
    if (!window.confirm(message)) return;
    setBusy(what);
    setError(null);
    try {
      setStatus(await (what === 'mcp' ? api.installMcp() : api.installSkill()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (what: 'mcp' | 'skill') => {
    if (!status) return;
    const message =
      what === 'mcp'
        ? `Remove AndruiTerminal MCP server from Claude Code for your user account?`
        : `Remove the AndruiTerminal skill file at:\n${status.skill.path}?`;
    if (!window.confirm(message)) return;
    setBusy(what === 'mcp' ? 'remove-mcp' : 'remove-skill');
    setError(null);
    try {
      setStatus(await (what === 'mcp' ? api.removeMcp() : api.removeSkill()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openJob = (jobId: string) => {
    setSelectedJobId(jobId);
    setIsJobDrawerOpen(true);
  };

  const mcpBadge = status && mcpState(status);
  const skillBadge = status && skillState(status);

  return (
    <div className="workspace-page ai-integration-page">
      <PageHeader
        title="AI Integration"
        description="Configure your assistant, connect your tools, and stay in control of every action."
        actions={
          <button className="btn btn-secondary btn-sm" onClick={loadStatus} disabled={busy !== null}>
            <RefreshCw size={13} className={busy === 'status' ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        }
      />

      {error && (
        <div className="alert alert-danger" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <PageTabs page="ai" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <AiConfiguration />
          <section className="helper-panel" aria-labelledby="ai-status-heading">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <Bot size={17} className="text-muted" />
                <h2 id="ai-status-heading" className="text-sm font-semibold">MCP and skill status</h2>
              </div>
            </div>
            <div className="helper-panel-body">
              {!status ? (
                <p className="text-sm text-muted">{busy === 'status' ? 'Checking…' : 'Status unavailable'}</p>
              ) : (
                <div className="ai-status-grid">
                  <div className="ai-status-card">
                    <div className="ai-status-card-head">
                      <span>Claude Code CLI</span>
                      <span className={`badge ${status.claudeCli.available ? 'badge-success' : 'badge-warning'}`}>
                        {status.claudeCli.available ? 'Found' : 'Not found'}
                      </span>
                    </div>
                    {status.claudeCli.available ? (
                      <dl className="ai-status-facts">
                        <dt>Location</dt>
                        <dd className="font-mono">{status.claudeCli.path}</dd>
                        <dt>Version</dt>
                        <dd>{status.claudeCli.version}</dd>
                      </dl>
                    ) : (
                      <p className="text-sm text-warning">{status.claudeCli.reason}</p>
                    )}
                  </div>

                  <div className="ai-status-card">
                    <div className="ai-status-card-head">
                      <div className="flex items-center gap-2">
                        <Plug size={15} className="text-muted" />
                        <span id="ai-mcp-heading">MCP server</span>
                      </div>
                      <span className={`badge ${mcpBadge!.className}`}>{mcpBadge!.label}</span>
                    </div>
                    <p className="text-xs text-muted">
                      Registers <span className="font-mono">andrui-terminal mcp</span> as the user-scope MCP server{' '}
                      <span className="font-mono">andrui</span>, pointing at this server.
                    </p>
                    {status.mcp.registered ? (
                      <dl className="ai-status-facts">
                        <dt>Scope</dt>
                        <dd className="font-mono">{status.mcp.scope}</dd>
                        <dt>Command</dt>
                        <dd className="font-mono">{[status.mcp.command, ...status.mcp.args].join(' ')}</dd>
                      </dl>
                    ) : (
                      <p className="text-sm text-muted">
                        No <span className="font-mono">andrui</span> entry in{' '}
                        <span className="font-mono">{status.mcp.configPath}</span>
                      </p>
                    )}
                    {status.mcp.reason && <p className="text-sm text-warning">{status.mcp.reason}</p>}
                    {status.mcp.restartRequired && (
                      <p className="text-sm text-warning">
                        The AndruiTerminal binary was replaced on disk. Restart the server to run the new version:{' '}
                        <span className="font-mono">systemctl --user restart andrui-terminal</span>
                      </p>
                    )}
                    <code className="approval-command" title={mcpCommand}>{mcpCommand}</code>
                    <div className="helper-actions mt-auto pt-2">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => install('mcp')}
                        disabled={busy !== null || !status?.claudeCli.available || status.mcp.matchesExpected}
                      >
                        {busy === 'mcp' ? 'Installing…' : status?.mcp.registered ? 'Update MCP' : 'Install MCP'}
                      </button>
                      {status?.mcp.registered && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => remove('mcp')}
                          disabled={busy !== null || !status?.claudeCli.available}
                        >
                          {busy === 'remove-mcp' ? 'Removing…' : 'Remove MCP'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="ai-status-card">
                    <div className="ai-status-card-head">
                      <div className="flex items-center gap-2">
                        <BookOpen size={15} className="text-muted" />
                        <span id="ai-skill-heading">Skill</span>
                      </div>
                      <span className={`badge ${skillBadge!.className}`}>{skillBadge!.label}</span>
                    </div>
                    <p className="text-xs text-muted">
                      Tells Claude to reach Android devices only through the AndruiTerminal tools and to wait for your approval
                      instead of falling back to <span className="font-mono">adb</span>. It is guidance: Claude Code does not
                      technically block <span className="font-mono">adb</span>.
                    </p>
                    <dl className="ai-status-facts">
                      <dt>Path</dt>
                      <dd className="font-mono">{status.skill.path}</dd>
                      <dt>Up to date</dt>
                      <dd>
                        {status.skill.installed ? (
                          <span className={`badge ${status.skill.upToDate ? 'badge-success' : 'badge-warning'}`}>
                            {status.skill.upToDate ? 'Up to date' : 'Outdated'}
                          </span>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </dl>
                    <details>
                      <summary className="text-sm">Show skill</summary>
                      <pre className="job-output">{status.skill.bundledContent}</pre>
                    </details>
                    <div className="helper-actions mt-auto pt-2">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => install('skill')}
                        disabled={busy !== null || !status || status.skill.upToDate}
                      >
                        {busy === 'skill' ? 'Installing…' : status?.skill.installed ? 'Update skill' : 'Install skill'}
                      </button>
                      {status?.skill.installed && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => remove('skill')}
                          disabled={busy !== null}
                        >
                          {busy === 'remove-skill' ? 'Removing…' : 'Remove skill'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <p className="text-xs text-dim">
                Claude Code reads MCP servers and skills when a session starts. Restart running sessions after installing.
              </p>
            </div>
          </section>
          {status && <details className="workspace-panel widget-disclosure client-connection"><summary className="widget-summary"><Plug size={17} className="widget-icon" /><span className="widget-heading"><span className="panel-title">Connect another MCP client</span><span className="widget-caption">Use the same device tools in your preferred client</span></span><span className="widget-chevron" aria-hidden="true">⌄</span></summary><div className="widget-body"><p className="text-xs text-muted">Use this stdio server definition in a client that supports MCP. Configuration syntax varies by client; compatibility must be checked using that client.</p><pre className="text-xs" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({ mcpServers: { andrui: { command: status.mcp.expectedCommand, args: status.mcp.expectedArgs } } }, null, 2)}</pre></div></details>}
          <McpAccessPanel />
          <section className="helper-panel" aria-labelledby="ai-test-heading">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <Activity size={17} className="text-muted" />
                <h2 id="ai-test-heading" className="text-sm font-semibold">Test MCP and agent queue</h2>
              </div>
            </div>
            <div className="helper-panel-body">
              <p className="text-sm text-muted">
                Test the Model Context Protocol stdio server diagnostics and simulate an agent approval request in the execution queue.
              </p>
              <div className="helper-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={runMcpTest}
                  disabled={busy !== null}
                >
                  {busy === 'test-mcp' ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Testing MCP…</span>
                    </>
                  ) : (
                    <>
                      <Activity size={13} />
                      <span>Run MCP diagnostic</span>
                    </>
                  )}
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={triggerTestApproval}
                  disabled={busy !== null}
                >
                  {busy === 'test-approval' ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Submitting request…</span>
                    </>
                  ) : (
                    <>
                      <Send size={13} />
                      <span>Simulate agent request</span>
                    </>
                  )}
                </button>
              </div>

              {simulatedMsg && (
                <div className="alert alert-info" role="status">
                  <span>{simulatedMsg}</span>
                </div>
              )}

              {testResult && (
                <div className="ai-status-card" data-testid="mcp-test-results">
                  <div className="ai-status-card-head">
                    <span>MCP server diagnostic result</span>
                    <span className={`badge ${testResult.ok ? 'badge-success' : 'badge-danger'}`}>
                      {testResult.ok ? 'Passed' : 'Failed'}
                    </span>
                  </div>
                  <dl className="ai-status-facts">
                    <dt>Latency</dt>
                    <dd>{testResult.latencyMs} ms</dd>
                    {testResult.protocolVersion && (
                      <>
                        <dt>Protocol</dt>
                        <dd className="font-mono">{testResult.protocolVersion}</dd>
                      </>
                    )}
                    {testResult.serverName && (
                      <>
                        <dt>Server info</dt>
                        <dd className="font-mono">
                          {testResult.serverName} {testResult.serverVersion ? `v${testResult.serverVersion}` : ''}
                        </dd>
                      </>
                    )}
                    <dt>Tools</dt>
                    <dd>
                      {testResult.toolCount} available
                      {testResult.tools.length > 0 ? (
                        <span className="text-dim"> ({testResult.tools.join(', ')})</span>
                      ) : null}
                    </dd>
                    <dt>Sample call</dt>
                    <dd>
                      <span className={`badge ${testResult.sampleToolCallOk ? 'badge-success' : 'badge-neutral'}`}>
                        {testResult.sampleToolCallOk ? 'android_list_devices verified' : 'Not verified'}
                      </span>
                    </dd>
                  </dl>
                  {testResult.details && <p className="text-xs text-muted">{testResult.details}</p>}
                  {testResult.error && <p className="text-sm text-danger">{testResult.error}</p>}
                </div>
              )}
            </div>
          </section>
          <QuickStats items={[{ label: 'Pending approvals', value: history.filter(item => item.status === 'pending').length }, { label: 'Recorded requests', value: history.length }, { label: 'Failed requests', value: history.filter(item => item.status === 'failed').length }]} />
          <section className="helper-panel" aria-labelledby="ai-queue-heading">
            <div className="panel-heading">
              <div className="flex items-center gap-2">
                <ListChecks size={17} className="text-muted" />
                <h2 id="ai-queue-heading" className="text-sm font-semibold">Execution queue</h2>
              </div>
            </div>
            <div className="helper-panel-body">
              <ApprovalsPanel deviceName={deviceName} emptyText="Nothing to approve. Your phone can breathe easy." confirmOnApprove={false} />
              {history.length > 0 && (
                <div className="table-container ai-history-container">
                  <table className="ai-history" aria-label="Agent requests">
                    <thead>
                      <tr>
                        <th className="ai-col-time">Time</th>
                        <th className="ai-col-severity">Severity</th>
                        <th className="ai-col-operation">Operation</th>
                        <th className="ai-col-params">Parameters</th>
                        <th className="ai-col-device">Device</th>
                        <th className="ai-col-status">Status</th>
                        <th className="ai-col-job text-right">Job</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleHistory.map((a) => (
                        <tr key={a.id}>
                          <td className="ai-col-time" title={new Date(a.createdAt).toLocaleString()}>
                            {new Date(a.createdAt).toLocaleTimeString()}
                          </td>
                          <td className="ai-col-severity">
                            <SeverityBadge severity={a.severity} />
                          </td>
                          <td className="ai-col-operation" title={a.preview.display}>
                            <span className="font-medium">{a.operationLabel}</span>{' '}
                            <span className="text-dim text-xs font-mono">({a.requester})</span>
                          </td>
                          <td className="ai-col-params">
                            <ParamList parameters={a.parameters} />
                          </td>
                          <td className="ai-col-device">{deviceName(a.deviceId)}</td>
                          <td className="ai-col-status">
                            <span className={`badge ${STATUS_BADGE[a.status]}`}>{a.status.replace('_', ' ')}</span>
                          </td>
                          <td className="ai-col-job text-right">
                            {a.jobId ? (
                              <button className="btn btn-ghost btn-sm" onClick={() => openJob(a.jobId!)}>
                                View
                              </button>
                            ) : (
                              <span className="text-dim" title={a.error}>
                                —
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {totalHistoryPages > 1 && (
                <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted">
                  <span>
                    Showing {currentHistoryPage * QUEUE_PAGE_SIZE + 1}–{Math.min(history.length, (currentHistoryPage + 1) * QUEUE_PAGE_SIZE)} of {history.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      aria-label="Previous page"
                      disabled={currentHistoryPage === 0}
                      onClick={() => setHistoryPage((p) => Math.max(0, p - 1))}
                    >
                      <ChevronLeft size={12} />
                    </button>
                    <span className="px-2 font-mono">
                      {currentHistoryPage + 1} / {totalHistoryPages}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      aria-label="Next page"
                      disabled={currentHistoryPage + 1 >= totalHistoryPages}
                      onClick={() => setHistoryPage((p) => Math.min(totalHistoryPages - 1, p + 1))}
                    >
                      <ChevronRight size={12} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      }]} />
    </div>
  );
};
