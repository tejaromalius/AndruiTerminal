import { WorkflowReports } from '../components/WorkflowReports.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { Workflow, WorkflowStep, Field } from '../types/api.js';
import { AutomationTools } from '../components/AutomationTools.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid } from '../components/TabKpiGrid.js';
import { WorkbenchList } from '../components/WorkbenchList.js';
import {
  Cpu,
  Play,
  Plus,
  Trash2,
  Edit2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Layers,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Upload,
} from 'lucide-react';

export const AutomationPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('automation', 'workspace');
  const {
    devices,
    selectedDeviceId,
    operations,
    jobs,
    refreshJobs,
  } = useWorkstation();

  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Active / Selected Workflow for Viewing or Editing
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);

  // Workflow Editor Form State
  const [editName, setEditName] = useState('');
  const [editSteps, setEditSteps] = useState<WorkflowStep[]>([]);
  const [expandedStepIndices, setExpandedStepIndices] = useState<number[]>([0]);
  const [uploadingField, setUploadingField] = useState<string | null>(null);

  // Execution target devices
  const [targetDeviceIds, setTargetDeviceIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  // Fetch workflows
  const loadWorkflows = useCallback(async () => {
    setError(null);
    try {
      const data = await api.getWorkflows();
      setWorkflows(data || []);
      if (data && data.length > 0 && !selectedWorkflow) {
        setSelectedWorkflow(data[0]);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    }
  }, [selectedWorkflow]);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  useEffect(() => { const reload = () => { loadWorkflows(); }; window.addEventListener('andrui:workflows-changed', reload); return () => window.removeEventListener('andrui:workflows-changed', reload); }, [loadWorkflows]);

  // Keep target device in sync
  useEffect(() => {
    if (selectedDeviceId && targetDeviceIds.length === 0) {
      setTargetDeviceIds([selectedDeviceId]);
    }
  }, [selectedDeviceId, targetDeviceIds.length]);

  const getDefaultParams = useCallback(
    (opId: string): Record<string, unknown> => {
      const op = operations.find((o) => o.id === opId);
      if (!op) return {};
      const initial: Record<string, unknown> = {};
      for (const f of op.fields) {
        if (f.default !== undefined) {
          initial[f.name] = f.default;
        }
      }
      return initial;
    },
    [operations]
  );

  const getMissingRequiredFields = useCallback(
    (step: WorkflowStep): Field[] => {
      const op = operations.find((o) => o.id === step.operationId);
      if (!op) return [];
      return op.fields.filter((f) => {
        if (!f.required) return false;
        const val = step.parameters[f.name];
        return val === undefined || val === null || val === '';
      });
    },
    [operations]
  );

  const hasValidationErrors = useCallback(() => {
    if (!editName.trim() || editSteps.length === 0) return true;
    return editSteps.some((step) => getMissingRequiredFields(step).length > 0);
  }, [editName, editSteps, getMissingRequiredFields]);

  const handleStartCreate = () => {
    setIsCreating(true);
    setEditingWorkflowId(null);
    setEditName('New Automated Pipeline');
    const initialParams = getDefaultParams('shell.exec');
    if (initialParams.command === undefined) {
      initialParams.command = 'getprop ro.build.version.release';
    }
    setEditSteps([
      {
        operationId: 'shell.exec',
        parameters: initialParams,
      },
    ]);
    setExpandedStepIndices([0]);
  };

  const handleStartEdit = (wf: Workflow) => {
    setIsCreating(true);
    setEditingWorkflowId(wf.id);
    setEditName(wf.name);
    setEditSteps(
      wf.steps && wf.steps.length > 0
        ? JSON.parse(JSON.stringify(wf.steps))
        : [{ operationId: 'shell.exec', parameters: getDefaultParams('shell.exec') }]
    );
    setExpandedStepIndices([0]);
  };

  const handleSaveWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hasValidationErrors()) return;
    try {
      if (editingWorkflowId) {
        const updated = await api.updateWorkflow(editingWorkflowId, {
          name: editName.trim(),
          steps: editSteps,
        });
        setWorkflows((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
        setSelectedWorkflow(updated);
      } else {
        const newWf = await api.createWorkflow({
          name: editName.trim(),
          steps: editSteps,
        });
        setWorkflows((prev) => [newWf, ...prev]);
        setSelectedWorkflow(newWf);
      }
      setIsCreating(false);
      setEditingWorkflowId(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save workflow failed');
    }
  };

  const handleDeleteWorkflow = async (id: string) => {
    try {
      await api.deleteWorkflow(id);
      setWorkflows((prev) => prev.filter((w) => w.id !== id));
      if (selectedWorkflow?.id === id) {
        setSelectedWorkflow(null);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // Jobs created by workflow runs started from this page.
  const [runJobIds, setRunJobIds] = useState<string[]>([]);
  const finishedRunJobs = jobs.filter(
    (j) => runJobIds.includes(j.id) && ['completed', 'failed', 'cancelled'].includes(j.status)
  );
  const passedRunJobs = finishedRunJobs.filter((j) => j.status === 'completed' && (j.exitCode ?? 0) === 0).length;
  const timedRunJobs = finishedRunJobs.filter((j) => j.startedAt && j.finishedAt);
  const meanStepMs = timedRunJobs.length
    ? Math.round(
        timedRunJobs.reduce((sum, j) => sum + (Date.parse(j.finishedAt!) - Date.parse(j.startedAt!)), 0) / timedRunJobs.length
      )
    : null;

  const handleRunWorkflow = async () => {
    if (!selectedWorkflow || targetDeviceIds.length === 0) return;
    const destructive = selectedWorkflow.steps.some(step => operations.find(op => op.id === step.operationId)?.destructive);
    if (destructive && !window.confirm(`Run destructive workflow steps on ${targetDeviceIds.join(', ')}?`)) return;
    setRunning(true);
    try {
      const { jobIds } = await api.runWorkflow(selectedWorkflow.id, targetDeviceIds, destructive);
      setRunJobIds((prev) => [...prev, ...jobIds]);
      refreshJobs();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Run workflow failed');
    } finally {
      setRunning(false);
    }
  };

  // Steps scroll inside the editor; a newly added step is scrolled into view.
  const stepsRef = useRef<HTMLDivElement>(null);
  const stepCount = useRef(0);
  useEffect(() => {
    if (editSteps.length > stepCount.current) stepsRef.current?.scrollTo?.({ top: stepsRef.current.scrollHeight, behavior: 'smooth' });
    stepCount.current = editSteps.length;
  }, [editSteps.length]);

  const addStep = () => {
    const defaultOp = operations[0]?.id || 'shell.exec';
    setEditSteps((prev) => {
      const nextIdx = prev.length;
      setExpandedStepIndices((exp) => (exp.includes(nextIdx) ? exp : [...exp, nextIdx]));
      return [
        ...prev,
        {
          operationId: defaultOp,
          parameters: getDefaultParams(defaultOp),
        },
      ];
    });
  };

  const removeStep = (index: number) => {
    setEditSteps((prev) => prev.filter((_, i) => i !== index));
    setExpandedStepIndices((prev) =>
      prev
        .filter((i) => i !== index)
        .map((i) => (i > index ? i - 1 : i))
    );
  };

  const updateStepOp = (index: number, opId: string) => {
    setEditSteps((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = {
          ...next[index],
          operationId: opId,
          parameters: getDefaultParams(opId),
        };
      }
      return next;
    });
  };

  const updateStepParam = (stepIndex: number, paramName: string, value: unknown) => {
    setEditSteps((prev) => {
      const next = [...prev];
      if (next[stepIndex]) {
        const updatedParams = { ...next[stepIndex].parameters };
        if (value === undefined || value === '') {
          delete updatedParams[paramName];
        } else {
          updatedParams[paramName] = value;
        }
        next[stepIndex] = {
          ...next[stepIndex],
          parameters: updatedParams,
        };
      }
      return next;
    });
  };

  const toggleStepExpand = (index: number) => {
    setExpandedStepIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  const handleFileUpload = async (stepIndex: number, fieldName: string, file: File) => {
    setUploadingField(`${stepIndex}_${fieldName}`);
    try {
      const artifact = await api.uploadArtifact(file);
      updateStepParam(stepIndex, fieldName, artifact.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'File upload failed');
    } finally {
      setUploadingField(null);
    }
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="Automation & Workflow Pipelines"
        description="Orchestrate multi-step ADB test workflows, assertions, condition waits, and multi-device runs"
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => { setActiveTab('workspace'); handleStartCreate(); }}>
            <Plus size={13} />
            <span>New Workflow</span>
          </button>
        }
      />

      {error && (
        <div className="alert alert-danger">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <PageTabs page="automation" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <WorkflowReports />
          <TabKpiGrid
            items={[
              {
                id: 'auto-pipelines-count',
                label: 'Saved Workflows',
                value: workflows.length,
                subtext: `${workflows.reduce((n, wf) => n + wf.steps.length, 0)} steps in total`,
                icon: Cpu,
                color: 'var(--emerald-accent)',
              },
              {
                id: 'auto-success-rate',
                label: 'Step Results',
                value: finishedRunJobs.length ? `${passedRunJobs} / ${finishedRunJobs.length}` : 'None yet',
                subtext: finishedRunJobs.length ? 'Steps passed, runs started from this page' : 'Run a workflow to see results',
                icon: CheckCircle2,
                badge: finishedRunJobs.length > passedRunJobs ? `${finishedRunJobs.length - passedRunJobs} failed` : undefined,
                badgeType: 'danger',
                color: 'var(--color-success)',
              },
              {
                id: 'auto-step-latency',
                label: 'Mean Step Time',
                value: meanStepMs === null ? '—' : meanStepMs < 1000 ? `${meanStepMs} ms` : `${(meanStepMs / 1000).toFixed(1)} s`,
                subtext: meanStepMs === null ? 'No finished steps yet' : `Across ${timedRunJobs.length} finished steps`,
                icon: Clock,
                color: 'var(--color-info)',
              },
              {
                id: 'auto-fleet-targets',
                label: 'Target Devices',
                value: targetDeviceIds.length,
                subtext: targetDeviceIds.length > 0 ? targetDeviceIds.join(', ') : 'No targets selected',
                icon: Layers,
                color: 'var(--color-purple)',
              },
            ]}
          />
          {/* Grid: Saved Workflows List & Selected Workflow Details / Editor */}
          <div className="app-workbench">
            {/* Left: Workflow List */}
            <WorkbenchList
              items={workflows.map((wf) => ({ id: wf.id, title: wf.name, subtitle: `${wf.steps?.length || 0} steps` }))}
              label="Saved Pipelines"
              placeholder="Filter workflows…"
              selected={isCreating ? '' : selectedWorkflow?.id ?? ''}
              onSelect={(id) => {
                const wf = workflows.find((w) => w.id === id);
                if (!wf) return;
                setSelectedWorkflow(wf);
                setIsCreating(false);
              }}
              status={workflows.length === 0 ? (
                <div className="empty-state workflow-empty">
                  <Cpu size={32} className="text-dim" />
                  <div className="text-xs text-dim">No workflows created yet</div>
                </div>
              ) : null}
            />

            {/* Right 2 cols: Workflow Viewer / Execution or Editor */}
            <div className="workspace-panel app-detail">
              {isCreating ? (
                /* Workflow Create / Edit Form */
                <form onSubmit={handleSaveWorkflow} className="flex flex-col gap-3 workflow-editor">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-main">
                      {editingWorkflowId ? 'Edit Automation Workflow' : 'Create Automation Workflow'}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setIsCreating(false);
                        setEditingWorkflowId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>

                  <div>
                    <label className="text-xs text-dim">Workflow Name</label>
                    <input
                      type="text"
                      className="input text-xs"
                      placeholder="e.g. Device Smoke Test"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      required
                    />
                  </div>

                  {/* Steps Editor */}
                  <div className="flex flex-col gap-2 workflow-steps-section">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-dim uppercase">Pipeline Steps</span>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={addStep}>
                        <Plus size={11} />
                        <span>Add Step</span>
                      </button>
                    </div>

                    <div className="workflow-steps-scroll" ref={stepsRef}>
                    {editSteps.map((step, idx) => {
                      const op = operations.find((o) => o.id === step.operationId);
                      const isExpanded = expandedStepIndices.includes(idx);
                      const missingFields = getMissingRequiredFields(step);
                      const configuredCount = Object.keys(step.parameters).filter(
                        (k) => step.parameters[k] !== undefined && step.parameters[k] !== ''
                      ).length;

                      return (
                        <div
                          key={idx}
                          className="flex flex-col bg-slate-900 border border-slate-800 rounded text-xs overflow-hidden"
                        >
                          {/* Step Card Header */}
                          <div className="flex items-center gap-2 p-2 bg-slate-800/60">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm p-1 text-dim hover:text-main"
                              onClick={() => toggleStepExpand(idx)}
                              aria-label={isExpanded ? `Collapse step ${idx + 1}` : `Expand step ${idx + 1}`}
                              title={isExpanded ? 'Collapse step' : 'Expand step'}
                            >
                              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            </button>

                            <span className="font-mono text-dim font-bold">#{idx + 1}</span>

                            <select
                              className="select text-xs font-mono flex-1"
                              value={step.operationId}
                              onChange={(e) => updateStepOp(idx, e.target.value)}
                            >
                              {operations.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label} ({o.id})
                                </option>
                              ))}
                            </select>

                            {/* Parameter Summary Pill */}
                            {missingFields.length > 0 ? (
                              <span
                                className="badge badge-danger text-xs whitespace-nowrap"
                                title={`Missing required: ${missingFields.map((f) => f.label).join(', ')}`}
                              >
                                Missing required ({missingFields.length})
                              </span>
                            ) : (
                              <span className="badge badge-neutral text-xs whitespace-nowrap">
                                {configuredCount > 0
                                  ? `${configuredCount} param${configuredCount !== 1 ? 's' : ''}`
                                  : 'No params'}
                              </span>
                            )}

                            <button
                              type="button"
                              className="btn btn-ghost btn-sm text-danger p-1"
                              onClick={() => removeStep(idx)}
                              disabled={editSteps.length === 1}
                              title="Remove step"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>

                          {/* Step Card Body: Parameter Controls */}
                          {isExpanded && (
                            <div className="flex flex-col gap-3 p-3 bg-slate-950/60 border-t border-slate-800">
                              {op ? (
                                op.fields.length > 0 ? (
                                  <div className="flex flex-col gap-3">
                                    <div className="text-xs font-semibold text-dim uppercase tracking-wider">
                                      Step Parameters ({op.fields.length})
                                    </div>
                                    {op.fields.map((f: Field) => {
                                      const val = step.parameters[f.name];
                                      const isMissing =
                                        f.required &&
                                        (val === undefined || val === null || val === '');
                                      return (
                                        <div key={f.name} className="flex flex-col gap-1">
                                          <div className="flex items-center justify-between">
                                            <label
                                              htmlFor={`step_${idx}_${f.name}`}
                                              className="text-xs font-medium text-main"
                                            >
                                              {f.label}
                                              {f.required && (
                                                <span className="text-danger ml-1">*</span>
                                              )}
                                            </label>
                                            <span className="text-xs text-dim font-mono">
                                              {f.name}
                                            </span>
                                          </div>

                                          {/* String Field */}
                                          {f.type === 'string' && (
                                            <input
                                              id={`step_${idx}_${f.name}`}
                                              type="text"
                                              className="input text-xs"
                                              style={{
                                                borderColor: isMissing
                                                  ? 'var(--color-danger)'
                                                  : undefined,
                                              }}
                                              placeholder={f.description || f.label}
                                              value={(val as string) || ''}
                                              onChange={(e) =>
                                                updateStepParam(idx, f.name, e.target.value)
                                              }
                                              required={f.required}
                                            />
                                          )}

                                          {/* Number Field */}
                                          {f.type === 'number' && (
                                            <input
                                              id={`step_${idx}_${f.name}`}
                                              type="number"
                                              className="input text-xs"
                                              style={{
                                                borderColor: isMissing
                                                  ? 'var(--color-danger)'
                                                  : undefined,
                                              }}
                                              placeholder={f.description || f.label}
                                              value={(val as number) ?? ''}
                                              onChange={(e) =>
                                                updateStepParam(
                                                  idx,
                                                  f.name,
                                                  e.target.value === ''
                                                    ? undefined
                                                    : Number(e.target.value)
                                                )
                                              }
                                              required={f.required}
                                            />
                                          )}

                                          {/* Boolean Field */}
                                          {f.type === 'boolean' && (
                                            <label className="flex items-center gap-2 cursor-pointer text-xs text-main">
                                              <input
                                                id={`step_${idx}_${f.name}`}
                                                type="checkbox"
                                                checked={Boolean(val)}
                                                onChange={(e) =>
                                                  updateStepParam(idx, f.name, e.target.checked)
                                                }
                                                style={{
                                                  accentColor: 'var(--emerald-accent)',
                                                  width: '15px',
                                                  height: '15px',
                                                }}
                                              />
                                              <span>Enable {f.label}</span>
                                            </label>
                                          )}

                                          {/* Select Field */}
                                          {f.type === 'select' && (
                                            <select
                                              id={`step_${idx}_${f.name}`}
                                              className="select text-xs"
                                              style={{
                                                borderColor: isMissing
                                                  ? 'var(--color-danger)'
                                                  : undefined,
                                              }}
                                              value={(val as string) || ''}
                                              onChange={(e) =>
                                                updateStepParam(idx, f.name, e.target.value)
                                              }
                                              required={f.required}
                                            >
                                              <option value="">Select an option...</option>
                                              {f.options?.map((opt) => (
                                                <option key={opt.value} value={opt.value}>
                                                  {opt.label} ({opt.value})
                                                </option>
                                              ))}
                                            </select>
                                          )}

                                          {/* Text / Multi-line Field */}
                                          {f.type === 'text' && (
                                            <textarea
                                              id={`step_${idx}_${f.name}`}
                                              className="textarea text-xs"
                                              style={{
                                                borderColor: isMissing
                                                  ? 'var(--color-danger)'
                                                  : undefined,
                                              }}
                                              rows={2}
                                              placeholder={f.description || f.label}
                                              value={(val as string) || ''}
                                              onChange={(e) =>
                                                updateStepParam(idx, f.name, e.target.value)
                                              }
                                              required={f.required}
                                            />
                                          )}

                                          {/* File Upload / Artifact Field */}
                                          {f.type === 'file' && (
                                            <div className="flex items-center gap-2">
                                              <label className="btn btn-secondary btn-sm cursor-pointer">
                                                <Upload size={12} />
                                                <span>
                                                  {uploadingField === `${idx}_${f.name}`
                                                    ? 'Uploading...'
                                                    : 'Choose File'}
                                                </span>
                                                <input
                                                  id={`step_${idx}_${f.name}`}
                                                  type="file"
                                                  style={{ display: 'none' }}
                                                  onChange={(e) => {
                                                    const file = e.target.files?.[0];
                                                    if (file) handleFileUpload(idx, f.name, file);
                                                  }}
                                                />
                                              </label>
                                              <span className="text-xs font-mono text-dim truncate flex-1">
                                                {val
                                                  ? `Artifact ID: ${val}`
                                                  : 'No file selected (uploads as artifact)'}
                                              </span>
                                            </div>
                                          )}

                                          {f.description && (
                                            <span className="text-xs text-dim">{f.description}</span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="text-xs text-dim italic">
                                    This operation requires no additional parameters.
                                  </div>
                                )
                              ) : (
                                <div className="text-xs text-dim italic">
                                  Select an operation above to configure parameters.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800">
                    <div className="text-xs text-dim">
                      {hasValidationErrors() && editSteps.length > 0 && editName.trim() ? (
                        <span className="text-danger flex items-center gap-1 font-medium">
                          <AlertCircle size={13} />
                          <span>Fill in all required parameters before saving</span>
                        </span>
                      ) : (
                        <span className="text-dim">
                          {editSteps.length} step{editSteps.length !== 1 ? 's' : ''} configured
                        </span>
                      )}
                    </div>
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm self-end"
                      disabled={hasValidationErrors()}
                    >
                      <span>{editingWorkflowId ? 'Update Workflow' : 'Save Workflow'}</span>
                    </button>
                  </div>
                </form>
              ) : selectedWorkflow ? (
                /* Selected Workflow Detail & Run View */
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-base font-semibold text-main">
                        {selectedWorkflow.name}
                      </div>
                      <div className="text-xs text-dim font-mono">
                        ID: {selectedWorkflow.id} • {selectedWorkflow.steps?.length || 0} Steps
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleStartEdit(selectedWorkflow)}
                        title="Edit workflow"
                      >
                        <Edit2 size={13} />
                        <span>Edit Workflow</span>
                      </button>

                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => handleDeleteWorkflow(selectedWorkflow.id)}
                        title="Delete workflow"
                      >
                        <Trash2 size={13} />
                        <span>Delete</span>
                      </button>

                      <button
                        className="btn btn-primary btn-sm"
                        onClick={handleRunWorkflow}
                        disabled={running || targetDeviceIds.length === 0}
                      >
                        <Play size={13} />
                        <span>{running ? 'Running Pipeline...' : 'Run on Selected Target(s)'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Target Devices Selection */}
                  <div className="flex flex-col gap-1.5 p-3 bg-slate-900 rounded border border-slate-800">
                    <span className="text-xs text-dim font-medium uppercase">
                      Target Devices for Run ({targetDeviceIds.length})
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {devices.map((d) => {
                        const isChecked = targetDeviceIds.includes(d.id);
                        return (
                          <label
                            key={d.id}
                            className="flex items-center gap-1.5 text-xs font-mono cursor-pointer p-1 rounded bg-black/40 border border-slate-700"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setTargetDeviceIds((prev) => [...prev, d.id]);
                                } else {
                                  setTargetDeviceIds((prev) => prev.filter((id) => id !== d.id));
                                }
                              }}
                            />
                            <span>{d.id}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Steps progression preview */}
                  <div className="flex flex-col gap-2">
                    <span className="text-xs text-dim font-medium uppercase">Execution Steps</span>
                    <div className="flex flex-col gap-2">
                      {selectedWorkflow.steps?.map((step, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-2.5 bg-slate-900 rounded border border-slate-800 text-xs font-mono"
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                              <span className="badge badge-neutral text-xs">Step {idx + 1}</span>
                              <span className="text-main font-semibold">{step.operationId}</span>
                            </div>
                            {step.parameters && Object.keys(step.parameters).length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1 text-[11px] font-mono">
                                {Object.entries(step.parameters).map(([k, v]) => (
                                  <span
                                    key={k}
                                    className="bg-slate-800/90 px-1.5 py-0.5 rounded border border-slate-700/60 text-dim"
                                  >
                                    <span className="text-slate-400">{k}:</span>{' '}
                                    <span className="text-slate-200">{String(v)}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <ArrowRight size={13} className="text-dim" />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <h2 className="panel-title flex items-center gap-2"><Cpu size={16} className="text-emerald" />Workflow details</h2>
                  <div className="empty-state workflow-empty">
                    <Cpu size={32} className="text-dim" />
                    <div className="text-xs text-dim">Select a workflow or click New Workflow</div>
                  </div>
                </>
              )}
            </div>
          </div>
          <AutomationTools showAll hideNavigation />
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Automation"
            title="Workflow & Automation Catalog"
            description="Public API automation steps, condition waiters, and multi-device coordination"
          />
        </>
      }]} />
    </div>
  );
};
