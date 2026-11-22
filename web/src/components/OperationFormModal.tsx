import React, { useState, useEffect, useCallback } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { Field, PreviewResponse } from '../types/api.js';
import {
  X,
  Play,
  AlertTriangle,
  Upload,
  Terminal,
  Loader2,
  Copy,
} from 'lucide-react';

export const OperationFormModal: React.FC = () => {
  const {
    activeModalOperation,
    closeOperationModal,
    modalDefaultParams,
    selectedDeviceId,
    setSelectedDeviceId,
    devices,
    runOperation,
  } = useWorkstation();

  const [params, setParams] = useState<Record<string, unknown>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [previewCopied, setPreviewCopied] = useState(false);

  // Close modal on Escape key
  useEffect(() => {
    if (!activeModalOperation) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeOperationModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModalOperation, closeOperationModal]);

  const formatCategory = (cat: string) => {
    switch (cat.toUpperCase()) {
      case 'C': return 'Device & Transport';
      case 'P': return 'Packages & Lifecycle';
      case 'F': return 'Files & Data';
      case 'E': return 'Execution & Shell';
      case 'D': return 'Logs & Diagnostics';
      case 'M': return 'Screen & Media';
      case 'A': return 'Workflows & Automation';
      case 'N': return 'Network Mappings';
      case 'S': return 'Users & Policy';
      case 'X': return 'System & Recovery';
      default: return cat;
    }
  };

  // Initialize parameters from defaults
  useEffect(() => {
    if (!activeModalOperation) return;
    const initial: Record<string, unknown> = { ...modalDefaultParams };
    for (const f of activeModalOperation.fields) {
      if (initial[f.name] === undefined && f.default !== undefined) {
        initial[f.name] = f.default;
      }
    }
    setParams(initial);
    setConfirmed(false);
    setSubmitError(null);
  }, [activeModalOperation, modalDefaultParams]);

  // Command preview live update
  const fetchPreview = useCallback(
    async (currentParams: Record<string, unknown>) => {
      if (!activeModalOperation) return;
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const res = await api.previewOperation(
          activeModalOperation.id,
          activeModalOperation.requiresDevice ? selectedDeviceId || undefined : undefined,
          currentParams
        );
        setPreview(res);
      } catch (err: unknown) {
        setPreviewError(err instanceof Error ? err.message : 'Preview unavailable');
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    },
    [activeModalOperation, selectedDeviceId]
  );

  useEffect(() => {
    if (!activeModalOperation) return;
    const timer = setTimeout(() => {
      fetchPreview(params);
    }, 250);
    return () => clearTimeout(timer);
  }, [activeModalOperation, params, fetchPreview]);

  if (!activeModalOperation) return null;

  const handleFieldChange = (name: string, value: unknown) => {
    setParams((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleFileUpload = async (fieldName: string, file: File) => {
    setUploadingField(fieldName);
    try {
      const artifact = await api.uploadArtifact(file);
      handleFieldChange(fieldName, artifact.id);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'File upload failed');
    } finally {
      setUploadingField(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeModalOperation) return;

    if (activeModalOperation.destructive && !confirmed) {
      setSubmitError('You must explicitly confirm this destructive operation.');
      return;
    }

    if (activeModalOperation.requiresDevice && !selectedDeviceId) {
      setSubmitError('This operation requires an active target device.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await runOperation(activeModalOperation.id, params, confirmed);
      closeOperationModal();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Operation execution failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={closeOperationModal}>
      <div
        className="modal-box"
        style={{ width: '680px', maxWidth: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{
            padding: '12px 18px',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-panel)',
          }}
        >
          <div>
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-main">
                {activeModalOperation.label}
              </span>
              <span className="badge badge-neutral text-xs">
                {formatCategory(activeModalOperation.category)}
              </span>
              {activeModalOperation.destructive && (
                <span className="badge badge-danger">Destructive</span>
              )}
            </div>
            <div className="text-xs text-dim font-mono" style={{ marginTop: '2px' }}>
              ID: {activeModalOperation.id} •{' '}
              {activeModalOperation.requiresDevice
                ? `Target: ${selectedDeviceId || 'No device selected'}`
                : 'Host operation'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={closeOperationModal}>
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div
            className="flex-1 overflow-auto"
            style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}
          >
            {/* Description & Availability Status */}
            <p className="text-xs text-muted leading-relaxed">
              {activeModalOperation.description}
            </p>

            {!activeModalOperation.available && (
              <div className="alert alert-warning">
                <AlertTriangle size={16} className="text-warning" />
                <div>
                  <div className="font-semibold">Operation Unavailable</div>
                  <div>
                    {activeModalOperation.unavailableReason ||
                      'This operation is not supported by current host ADB or configuration.'}
                  </div>
                </div>
              </div>
            )}

            {activeModalOperation.requiresDevice && devices.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--bg-card)',
                  padding: '10px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-xs text-dim font-medium whitespace-nowrap">Target Device:</span>
                  <select
                    className="select text-xs font-mono flex-1"
                    value={selectedDeviceId || ''}
                    onChange={(e) => setSelectedDeviceId(e.target.value || null)}
                  >
                    <option value="" disabled>Select target device...</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.id} ({d.state}) {d.model ? `- ${d.model}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Parameter Fields */}
            {activeModalOperation.fields.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  backgroundColor: 'var(--bg-card)',
                  padding: '14px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div className="text-xs font-semibold text-dim uppercase tracking-wider">
                  Parameters
                </div>

                {activeModalOperation.fields.map((f: Field) => (
                  <div key={f.name} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-main">
                        {f.label}
                        {f.required && <span className="text-danger ml-1">*</span>}
                      </label>
                      <span className="text-xs text-dim font-mono">{f.name}</span>
                    </div>

                    {/* Field Types */}
                    {f.type === 'string' && (
                      <input
                        type="text"
                        className="input"
                        placeholder={f.description || f.label}
                        value={(params[f.name] as string) || ''}
                        onChange={(e) => handleFieldChange(f.name, e.target.value)}
                        required={f.required}
                      />
                    )}

                    {f.type === 'number' && (
                      <input
                        type="number"
                        className="input"
                        placeholder={f.description || f.label}
                        value={(params[f.name] as number) ?? ''}
                        onChange={(e) =>
                          handleFieldChange(
                            f.name,
                            e.target.value === '' ? undefined : Number(e.target.value)
                          )
                        }
                        required={f.required}
                      />
                    )}

                    {f.type === 'boolean' && (
                      <label className="flex items-center gap-2 cursor-pointer text-xs text-main">
                        <input
                          type="checkbox"
                          checked={Boolean(params[f.name])}
                          onChange={(e) => handleFieldChange(f.name, e.target.checked)}
                          style={{ accentColor: 'var(--emerald-accent)', width: '16px', height: '16px' }}
                        />
                        <span>Enable {f.label}</span>
                      </label>
                    )}

                    {f.type === 'select' && (
                      <select
                        className="select"
                        value={(params[f.name] as string) || ''}
                        onChange={(e) => handleFieldChange(f.name, e.target.value)}
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

                    {f.type === 'text' && (
                      <textarea
                        className="textarea"
                        rows={3}
                        placeholder={f.description || f.label}
                        value={(params[f.name] as string) || ''}
                        onChange={(e) => handleFieldChange(f.name, e.target.value)}
                        required={f.required}
                      />
                    )}

                    {f.type === 'file' && (
                      <div className="flex items-center gap-2">
                        <label className="btn btn-secondary btn-sm cursor-pointer">
                          <Upload size={13} />
                          <span>
                            {uploadingField === f.name ? 'Uploading...' : 'Choose File'}
                          </span>
                          <input
                            type="file"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleFileUpload(f.name, file);
                            }}
                          />
                        </label>
                        <span className="text-xs font-mono text-dim truncate flex-1">
                          {params[f.name]
                            ? `Artifact ID: ${params[f.name]}`
                            : 'No file selected (uploads as artifact)'}
                        </span>
                      </div>
                    )}

                    {f.description && (
                      <span className="text-xs text-dim">{f.description}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Live Command Preview Box */}
            <div
              style={{
                backgroundColor: 'var(--bg-input)',
                border: '1px solid var(--border-card)',
                borderRadius: '6px',
                padding: '10px 14px',
              }}
            >
              <div className="flex items-center justify-between text-xs text-dim font-mono mb-1">
                <div className="flex items-center gap-1.5">
                  <Terminal size={12} className="text-emerald" />
                  <span>COMMAND PREVIEW</span>
                </div>
                <div className="flex items-center gap-2">
                  {previewLoading && (
                    <span className="text-xs text-emerald flex items-center gap-1">
                      <Loader2 size={11} className="animate-spin" /> Updating...
                    </span>
                  )}
                  {preview && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '2px 6px', fontSize: '11px' }}
                      onClick={() => {
                        const cmdText =
                          preview.display ||
                          `${preview.program} ${preview.args?.join(' ') || ''}`;
                        navigator.clipboard.writeText(cmdText);
                        setPreviewCopied(true);
                        setTimeout(() => setPreviewCopied(false), 2000);
                      }}
                      title="Copy command preview"
                    >
                      <Copy size={11} />
                      <span>{previewCopied ? 'Copied' : 'Copy'}</span>
                    </button>
                  )}
                </div>
              </div>

              {preview ? (
                <div
                  className="font-mono text-xs text-emerald overflow-x-auto"
                  style={{
                    backgroundColor: 'var(--bg-input)',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {preview.display ||
                    `${preview.program} ${preview.args?.join(' ') || ''}`}
                </div>
              ) : previewError ? (
                <div className="text-xs text-dim italic">
                  Command preview: {previewError}
                </div>
              ) : (
                <div className="text-xs text-dim italic">Generating preview...</div>
              )}
            </div>

            {/* Destructive Warning Confirmation */}
            {activeModalOperation.destructive && (
              <div className="alert alert-danger">
                <AlertTriangle size={18} className="text-danger flex-shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold text-danger">
                    Destructive Action Safeguard
                  </div>
                  <div className="text-xs text-danger mb-2">
                    This operation will modify, wipe, or permanently affect data on target
                    device ({selectedDeviceId || 'unknown'}). Explicit confirmation is
                    required.
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-main">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      style={{ accentColor: 'var(--color-danger)', width: '16px', height: '16px' }}
                    />
                    <span>
                      I confirm I want to execute this destructive operation on{' '}
                      {selectedDeviceId || 'target device'}.
                    </span>
                  </label>
                </div>
              </div>
            )}

            {submitError && (
              <div className="alert alert-danger">
                <AlertTriangle size={14} />
                <span>{submitError}</span>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div
            className="flex items-center justify-between"
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--bg-panel)',
            }}
          >
            <span className="text-xs text-dim font-mono">
              {activeModalOperation.streaming ? 'Streams Output' : 'Standard Execution'}
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={closeOperationModal}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`btn btn-sm ${
                  activeModalOperation.destructive ? 'btn-danger' : 'btn-primary'
                }`}
                disabled={
                  isSubmitting ||
                  (activeModalOperation.destructive && !confirmed) ||
                  !activeModalOperation.available ||
                  (activeModalOperation.requiresDevice && !selectedDeviceId)
                }
              >
                {isSubmitting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Play size={13} />
                )}
                <span>Run Operation</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
