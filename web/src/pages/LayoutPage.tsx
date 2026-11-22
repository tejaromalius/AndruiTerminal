import { QuickStats } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useEffect, useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { OperationCardList } from '../components/OperationCardList.js';
import {
  Layers,
  MousePointer,
  RefreshCw,
  AlertCircle,
  Code,
  ChevronRight,
  Eye,
  Play,
  Square,
} from 'lucide-react';

interface HierarchyNode {
  id: string;
  className: string;
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  bounds?: string;
  clickable?: boolean;
  enabled?: boolean;
  children?: HierarchyNode[];
}

export const LayoutPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('layout', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    runOperation,
  } = useWorkstation();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<HierarchyNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<HierarchyNode | null>(null);

  // Semantic Action input
  const [targetSelector, setTargetSelector] = useState('');
  const [actionType, setActionType] = useState('click');
  const [actionLoading, setActionLoading] = useState(false);
  const [helperSession, setHelperSession] = useState<string | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  // The session lives on the server; reload it so leaving and returning to this page keeps it.
  useEffect(() => {
    setHelperSession(null);
    if (!selectedDeviceId) return;
    let cancelled = false;
    api.listAutomationSessions()
      .then(sessions => {
        if (cancelled || !Array.isArray(sessions)) return;
        setHelperSession(sessions.find(session => session.deviceId === selectedDeviceId)?.id ?? null);
      })
      .catch(() => { /* No session information; keep showing the start button. */ });
    return () => { cancelled = true; };
  }, [selectedDeviceId]);
  const toggleHelper = async () => {
    if (!selectedDeviceId) return;
    setHelperBusy(true); setError(null);
    try {
      if (helperSession) { await api.stopAutomationSession(helperSession); setHelperSession(null); }
      else { const session = await api.startAutomationSession(selectedDeviceId); setHelperSession(session.id); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setHelperBusy(false); }
  };

  // Fetch hierarchy
  const handleDumpHierarchy = async () => {
    setActiveTab('workspace');
    if (!selectedDeviceId) return;
    setLoading(true);
    setError(null);
    try {
      try {
        const res = await api.getAutomationHierarchy(selectedDeviceId);
        if (res.hierarchy) {
          parseHierarchyXml(res.hierarchy);
          setLoading(false);
          return;
        }
      } catch {
        // Fall back to snapshot dump
        const fallbackRes = await api.getAutomationHierarchy(selectedDeviceId, true);
        if (fallbackRes.hierarchy) {
          parseHierarchyXml(fallbackRes.hierarchy);
          setLoading(false);
          return;
        }
      }

      const op = findOperation('dump_hierarchy') || findOperation('uiautomator');
      if (op) {
        const job = await runOperation(op.id, {});
        if (job.stdout) {
          parseHierarchyXml(job.stdout);
        }
      } else {
        throw new Error('No hierarchy provider is available. Start the automation helper for this device.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Hierarchy dump failed');
    } finally {
      setLoading(false);
    }
  };

  const parseHierarchyXml = (xmlString: string) => {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlString, 'text/xml');

      let counter = 0;
      const walk = (el: Element): HierarchyNode => {
        counter++;
        const node: HierarchyNode = {
          id: `node-${counter}`,
          className: el.getAttribute('class') || el.tagName,
          resourceId: el.getAttribute('resource-id') || undefined,
          text: el.getAttribute('text') || undefined,
          contentDesc: el.getAttribute('content-desc') || undefined,
          bounds: el.getAttribute('bounds') || undefined,
          clickable: el.getAttribute('clickable') === 'true',
          enabled: el.getAttribute('enabled') === 'true',
          children: [],
        };

        for (let i = 0; i < el.children.length; i++) {
          const childEl = el.children[i];
          if (childEl) {
            node.children?.push(walk(childEl));
          }
        }
        return node;
      };

      const rootEl = doc.documentElement;
      if (rootEl) {
        const parsed = walk(rootEl);
        setNodes([parsed]);
        setSelectedNode(parsed);
      }
    } catch {
      // ignore XML parse error
    }
  };

  const handleRunSemanticAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetSelector || !selectedDeviceId) return;
    setActionLoading(true);
    try {
      await api.runAutomationAction(selectedDeviceId, {
        type: actionType,
        selector: targetSelector,
      });
      setTimeout(handleDumpHierarchy, 1000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const renderTree = (node: HierarchyNode) => {
    const isSelected = selectedNode?.id === node.id;
    return (
      <div key={node.id} style={{ marginLeft: '12px' }}>
        <div
          onClick={() => {
            setSelectedNode(node);
            if (node.resourceId) setTargetSelector(node.resourceId);
            else if (node.text) setTargetSelector(node.text);
          }}
          className="flex items-center gap-1.5 py-1 px-2 rounded cursor-pointer text-xs font-mono"
          style={{
            backgroundColor: isSelected ? 'var(--emerald-surface)' : 'transparent',
            color: isSelected ? 'var(--emerald-accent)' : 'var(--text-muted)',
            border: isSelected ? '1px solid var(--emerald-border)' : '1px solid transparent',
          }}
        >
          <ChevronRight size={12} className="text-dim" />
          <span className="font-semibold">{node.className.split('.').pop()}</span>
          {node.text && (
            <span className="text-dim truncate" style={{ maxWidth: '140px' }}>
              &quot;{node.text}&quot;
            </span>
          )}
          {node.resourceId && (
            <span className="text-emerald truncate" style={{ maxWidth: '140px' }}>
              #{node.resourceId.split('/').pop()}
            </span>
          )}
        </div>
        {node.children && node.children.map((child) => renderTree(child))}
      </div>
    );
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="Layout & Accessibility Inspector"
        description="Inspect Android accessibility window hierarchies, semantic selectors, and node properties"
        actions={helperSession ? (
          <div className="flex items-center gap-2">
            <span className="helper-running"><span className="connection-dot connected" />Helper running</span>
            <button className="btn btn-secondary btn-sm" disabled={helperBusy} onClick={toggleHelper}>
              <Square size={13} />{helperBusy ? 'Stopping helper…' : 'Stop helper'}
            </button>
          </div>
        ) : undefined}
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      {error && (
        <div className="alert alert-danger">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <PageTabs page="layout" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <QuickStats items={[{ label: 'Hierarchy nodes', value: nodes.reduce(function count(total: number, node: HierarchyNode): number { return total + 1 + (node.children ?? []).reduce(count, 0); }, 0) }, { label: 'Selected node', value: selectedNode?.id ?? 'None' }, { label: 'Helper session', value: helperSession ? 'Active' : 'Not started' }]} />
          <div
            className="flex items-center justify-between"
            style={{
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '12px 16px',
            }}
          >
            <div className="flex items-center gap-2">
              <Layers size={16} className="text-emerald" />
              <h2 className="panel-title">Accessibility Window Tree</h2>
            </div>

            {/* The helper provides the hierarchy, so start it first; capture takes its place once it runs. */}
            {helperSession ? (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleDumpHierarchy}
                disabled={loading || !selectedDeviceId}
              >
                <RefreshCw
                  size={13}
                  style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}
                />
                <span>{loading ? 'Dumping UI Hierarchy...' : 'Capture Window Hierarchy'}</span>
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" disabled={!selectedDeviceId || helperBusy} onClick={toggleHelper}>
                <Play size={13} />{helperBusy ? 'Starting helper…' : 'Install & start automation helper'}
              </button>
            )}
          </div>
          <div className="aligned-panels grid grid-cols-2 gap-4">
            {/* Tree View Box */}
            <div className="workspace-panel inspector-panel">
              <h3 className="flex items-center gap-2"><Layers size={16} className="text-emerald" />Hierarchy nodes</h3>
              {nodes.length === 0 ? (
                <div className="empty-state inspector-empty">
                  <Layers size={36} className="text-dim" />
                  <div className="text-xs text-dim">
                    No hierarchy captured yet. {helperSession ? <>Click &quot;Capture Window Hierarchy&quot;.</> : <>Start the automation helper, then capture.</>}
                  </div>
                </div>
              ) : (
                nodes.map((n) => renderTree(n))
              )}
            </div>

            {/* Node Properties Sheet */}
            <div className="workspace-panel inspector-panel">
              <h3 className="flex items-center gap-2"><Eye size={16} className="text-emerald" />Node attributes</h3>

              {selectedNode ? (
                <div className="flex flex-col gap-2 font-mono text-xs">
                  <div className="p-2 bg-slate-900 rounded border border-slate-800">
                    <span className="text-dim">Class: </span>
                    <span className="text-main font-semibold">{selectedNode.className}</span>
                  </div>
                  <div className="p-2 bg-slate-900 rounded border border-slate-800">
                    <span className="text-dim">Resource ID: </span>
                    <span className="text-emerald">{selectedNode.resourceId || 'None'}</span>
                  </div>
                  <div className="p-2 bg-slate-900 rounded border border-slate-800">
                    <span className="text-dim">Text Content: </span>
                    <span className="text-main">{selectedNode.text || 'None'}</span>
                  </div>
                  <div className="p-2 bg-slate-900 rounded border border-slate-800">
                    <span className="text-dim">Bounds: </span>
                    <span className="text-muted">{selectedNode.bounds || 'None'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2 bg-slate-900 rounded border border-slate-800">
                      <span className="text-dim">Clickable: </span>
                      <span className={selectedNode.clickable ? 'text-emerald' : 'text-dim'}>
                        {String(selectedNode.clickable)}
                      </span>
                    </div>
                    <div className="p-2 bg-slate-900 rounded border border-slate-800">
                      <span className="text-dim">Enabled: </span>
                      <span className={selectedNode.enabled ? 'text-emerald' : 'text-dim'}>
                        {String(selectedNode.enabled)}
                      </span>
                    </div>
                  </div>

                  {/* Semantic Action Runner */}
                  <form onSubmit={handleRunSemanticAction} className="flex flex-col gap-2 mt-2 pt-2 border-t border-slate-800">
                    <label className="text-dim font-sans font-medium">Trigger Action on Target</label>
                    <div className="flex gap-2">
                      <select
                        className="select text-xs font-mono"
                        style={{ width: '100px' }}
                        value={actionType}
                        onChange={(e) => setActionType(e.target.value)}
                      >
                        <option value="click">Click</option>
                        <option value="longClick">Long Click</option>
                        <option value="getText">Get Text</option>
                      </select>
                      <input
                        type="text"
                        className="input text-xs font-mono flex-1"
                        placeholder="Selector: ID or text"
                        value={targetSelector}
                        onChange={(e) => setTargetSelector(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="btn btn-secondary btn-sm"
                        disabled={actionLoading || !targetSelector || !selectedDeviceId}
                      >
                        <MousePointer size={12} />
                        <span>Run</span>
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="empty-state inspector-empty">
                  <Eye size={36} className="text-dim" />
                  <div className="text-xs text-dim">Select a node from the hierarchy tree to inspect</div>
                </div>
              )}
            </div>
          </div>
          <section className="workspace-panel extension-note" aria-labelledby="automation-extension-heading">
            <div className="flex items-center gap-2">
              <Code size={16} className="text-emerald flex-shrink-0" />
              <h2 id="automation-extension-heading">Automation Extension Subcontract</h2>
            </div>
            <p className="text-xs text-dim leading-relaxed">
              Semantic accessibility automation routes are specified under{' '}
              <code className="text-emerald font-mono">/api/v1/automation</code>.
            </p>
            <p className="text-xs text-dim leading-relaxed">
              High-level UI Automator instrumentation helpers provide condition waits,
              element assertions, and coordinated locks.
            </p>
          </section>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <> <OperationCardList
          category="Automation"
          title="Semantic Automation Operations"
          description="Hierarchy dumping, condition assertion, OCR/image matching, and UI Automator helpers"
        /> </>
      }]} />
    </div>
  );
};
