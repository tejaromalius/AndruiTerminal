import { QuickStats } from './AssessmentWidgets.js';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { ApiError } from '../api/client.js';
import {
  automationClient,
  OcrResponse,
  MatchResponse,
  RecordingDetail,
  ReplayEvent,
} from '../lib/automationClient.js';
import {
  FileText,
  Crosshair,
  Disc,
  Play,
  Square,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  Layers,
  Clock,
  Eye,
  ImageUp,
} from 'lucide-react';

/** Styled file picker: the native input stays (and keeps its test id) but the label shows the choice. */
const FilePick: React.FC<{ file: File | null; placeholder: string; children: React.ReactElement }> = ({ file, placeholder, children }) => (
  <label className={`file-pick ${file ? 'has-file' : ''}`}>
    {children}
    <ImageUp size={15} />
    <span className="file-pick-name">{file ? file.name : placeholder}</span>
    {file && <span className="file-pick-size">{(file.size / 1024).toFixed(1)} KB</span>}
  </label>
);

/** Card header in the all-tools layout: icon, title and current status. */
const ToolHead: React.FC<{ icon: React.ReactNode; title: string; status?: string; tone?: string }> = ({ icon, title, status, tone }) => (
  <div className="tool-head">
    <h3 className="panel-title">{icon}{title}</h3>
    {status && <span className={`badge badge-${tone}`}>{status}</span>}
  </div>
);
const toneOf = (status: string) => /disconnect|idle|stopped|not run/i.test(status) ? 'neutral' : /running|active|connecting|recording/i.test(status) ? 'info' : /fail|error/i.test(status) ? 'danger' : /complete|connected/i.test(status) ? 'success' : 'neutral';

export type TabType = 'ocr' | 'match' | 'recordings' | 'replay' | 'events';

export const AutomationTools: React.FC<{
  tab?: TabType; onTabChange?: (tab: TabType) => void; hideNavigation?: boolean; showAll?: boolean;
}> = ({ tab, onTabChange, hideNavigation = false, showAll = false }) => {
  const { selectedDeviceId } = useWorkstation();

  const [localTab, setLocalTab] = useState<TabType>('ocr');
  const activeTab = tab ?? localTab;
  const setActiveTab = (next: TabType) => {
    if (showAll) {
      document.querySelector(`[data-testid="${next}-section"]`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    } else (onTabChange ?? setLocalTab)(next);
  };

  // ==========================================
  // 1. OCR State
  // ==========================================
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  // Object URL for the OCR preview; revoked when the file changes.
  const [ocrPreviewUrl, setOcrPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!ocrFile || !showAll || typeof URL.createObjectURL !== 'function') { setOcrPreviewUrl(null); return; }
    const url = URL.createObjectURL(ocrFile);
    setOcrPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [ocrFile, showAll]);
  const [ocrLang, setOcrLang] = useState('eng');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<{ code?: string; message: string } | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResponse | null>(null);

  const handleOcrFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setOcrFile(file);
    setOcrError(null);
    setOcrResult(null);
  };

  const handleRunOcr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ocrFile) return;
    setOcrLoading(true);
    setOcrError(null);
    setOcrResult(null);
    try {
      const result = await automationClient.runOcr(ocrFile, ocrLang);
      setOcrResult(result);
    } catch (err: unknown) {
      setOcrError({
        code: err instanceof ApiError ? err.code : 'ocr_failed',
        message: err instanceof Error ? err.message : 'OCR execution failed',
      });
    } finally {
      setOcrLoading(false);
    }
  };

  // ==========================================
  // 2. Template Matching State
  // ==========================================
  const [matchSourceFile, setMatchSourceFile] = useState<File | null>(null);
  const [matchTemplateFile, setMatchTemplateFile] = useState<File | null>(null);
  const [matchThreshold, setMatchThreshold] = useState<number>(0.8);
  const [matchMaxMatches, setMatchMaxMatches] = useState<number>(10);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<{ code?: string; message: string } | null>(null);
  const [matchResult, setMatchResult] = useState<MatchResponse | null>(null);

  const handleRunMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matchSourceFile || !matchTemplateFile) return;
    setMatchLoading(true);
    setMatchError(null);
    setMatchResult(null);
    try {
      const result = await automationClient.runTemplateMatch(
        matchSourceFile,
        matchTemplateFile,
        matchThreshold,
        matchMaxMatches
      );
      setMatchResult(result);
    } catch (err: unknown) {
      setMatchError({
        code: err instanceof ApiError ? err.code : 'match_failed',
        message: err instanceof Error ? err.message : 'Template matching failed',
      });
    } finally {
      setMatchLoading(false);
    }
  };

  // ==========================================
  // 3. Action Recordings State
  // ==========================================
  const [activeRecordingId, setActiveRecordingId] = useState<string | null>(null);
  const [activeRecordingDeviceId, setActiveRecordingDeviceId] = useState<string | null>(null);
  const [recordingName, setRecordingName] = useState('');
  const [recordingsList, setRecordingsList] = useState<RecordingDetail[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<RecordingDetail | null>(null);
  const [recordingsLoading, setRecordingsLoading] = useState(false);
  const [recordingActionLoading, setRecordingActionLoading] = useState(false);
  const [recordingError, setRecordingError] = useState<{ code?: string; message: string } | null>(null);

  const loadRecordings = useCallback(async () => {
    setRecordingsLoading(true);
    try {
      const list = await automationClient.listRecordings();
      setRecordingsList(list);
    } catch (err: unknown) {
      setRecordingError({
        code: err instanceof ApiError ? err.code : 'recordings_load_failed',
        message: err instanceof Error ? err.message : 'Failed to list recordings',
      });
    } finally {
      setRecordingsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecordings();
  }, [loadRecordings]);

  const handleStartRecording = async () => {
    if (!selectedDeviceId) return;
    setRecordingActionLoading(true);
    setRecordingError(null);
    try {
      const res = await automationClient.startRecording(selectedDeviceId, recordingName);
      setActiveRecordingId(res.id);
      setActiveRecordingDeviceId(res.deviceId);
      setRecordingName('');
    } catch (err: unknown) {
      setRecordingError({
        code: err instanceof ApiError ? err.code : 'start_recording_failed',
        message: err instanceof Error ? err.message : 'Failed to start recording',
      });
    } finally {
      setRecordingActionLoading(false);
    }
  };

  const handleStopRecording = async () => {
    if (!activeRecordingId) return;
    setRecordingActionLoading(true);
    setRecordingError(null);
    try {
      const detail = await automationClient.stopRecording(activeRecordingId);
      setActiveRecordingId(null);
      setActiveRecordingDeviceId(null);
      setSelectedRecording(detail);
      await loadRecordings();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'recording_not_found') {
        setActiveRecordingId(null);
        setActiveRecordingDeviceId(null);
      }
      setRecordingError({
        code: err instanceof ApiError ? err.code : 'stop_recording_failed',
        message: err instanceof Error ? err.message : 'Failed to stop recording',
      });
    } finally {
      setRecordingActionLoading(false);
    }
  };

  const handleViewRecording = async (id: string) => {
    try {
      const detail = await automationClient.getRecording(id);
      setSelectedRecording(detail);
    } catch (err: unknown) {
      setRecordingError({
        code: err instanceof ApiError ? err.code : 'get_recording_failed',
        message: err instanceof Error ? err.message : 'Failed to load recording steps',
      });
    }
  };

  // ==========================================
  // 4. Action Replay State & WebSocket
  // ==========================================
  const [replayRecordingId, setReplayRecordingId] = useState<string>('');
  const [activeReplayId, setActiveReplayId] = useState<string | null>(null);
  const [replayStatus, setReplayStatus] = useState<
    'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  >('idle');
  const [replayTotalSteps, setReplayTotalSteps] = useState(0);
  const [replayCurrentStep, setReplayCurrentStep] = useState(0);
  const [replayEvents, setReplayEvents] = useState<ReplayEvent[]>([]);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<{ code?: string; message: string } | null>(null);
  const replayWsRef = useRef<WebSocket | null>(null);

  const handleStartReplay = async () => {
    if (!selectedDeviceId || !replayRecordingId) return;
    setReplayLoading(true);
    setReplayError(null);
    setReplayEvents([]);
    try {
      await automationClient.prepareWsSession();
      const res = await automationClient.startReplay(replayRecordingId, selectedDeviceId);
      setActiveReplayId(res.id);
      setReplayStatus('running');
      setReplayTotalSteps(res.totalSteps);
      setReplayCurrentStep(0);

      const wsUrl = automationClient.getReplayWebSocketUrl(res.id);
      const ws = new WebSocket(wsUrl);
      replayWsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.error) {
            setReplayError({ code: data.error.code, message: data.error.message });
            setReplayStatus('failed');
            return;
          }
          const replayEvt = data as ReplayEvent;
          setReplayEvents((prev) => [...prev, replayEvt]);
          if (replayEvt.stepIndex !== undefined) {
            setReplayCurrentStep(replayEvt.stepIndex + 1);
          }
          if (['completed', 'failed', 'cancelled'].includes(replayEvt.status)) {
            setReplayStatus(replayEvt.status as 'completed' | 'failed' | 'cancelled');
          }
        } catch {
          // JSON parse ignore
        }
      };

      ws.onerror = () => {
        setReplayError({ code: 'ws_error', message: 'Replay WebSocket stream error' });
        setReplayStatus('failed');
      };
    } catch (err: unknown) {
      setReplayError({
        code: err instanceof ApiError ? err.code : 'replay_start_failed',
        message: err instanceof Error ? err.message : 'Failed to start replay',
      });
      setReplayStatus('failed');
    } finally {
      setReplayLoading(false);
    }
  };

  const handleCancelReplay = async () => {
    if (!activeReplayId) return;
    setReplayLoading(true);
    try {
      await automationClient.cancelReplay(activeReplayId);
      setReplayStatus('cancelled');
      if (replayWsRef.current) {
        replayWsRef.current.close();
        replayWsRef.current = null;
      }
    } catch (err: unknown) {
      setReplayError({
        code: err instanceof ApiError ? err.code : 'replay_cancel_failed',
        message: err instanceof Error ? err.message : 'Failed to cancel replay',
      });
    } finally {
      setReplayLoading(false);
    }
  };

  // ==========================================
  // 5. Accessibility Events Stream State & WS
  // ==========================================
  const [streamStatus, setStreamStatus] = useState<
    'disconnected' | 'connecting' | 'connected' | 'error'
  >('disconnected');
  const [eventsList, setEventsList] = useState<Record<string, unknown>[]>([]);
  const [sequenceGapWarning, setSequenceGapWarning] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<{ code?: string; message: string } | null>(null);
  const eventsWsRef = useRef<WebSocket | null>(null);

  const handleStartStream = async () => {
    if (!selectedDeviceId) return;
    setStreamStatus('connecting');
    setStreamError(null);
    setSequenceGapWarning(null);
    try {
      await automationClient.prepareWsSession();
      const wsUrl = automationClient.getEventsWebSocketUrl(selectedDeviceId);
      const ws = new WebSocket(wsUrl);
      eventsWsRef.current = ws;

      ws.onopen = () => {
        setStreamStatus('connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.error) {
            const msg =
              data.error.code === 'session_not_found'
                ? `${data.error.message}. Start the automation helper on the Layout page.`
                : data.error.message;
            setStreamError({ code: data.error.code, message: msg });
            setStreamStatus('error');
            return;
          }
          if (data.type === 'sequence_gap') {
            setSequenceGapWarning(
              data.message ||
              `Event buffer overflow: ${data.dropped} accessibility events were dropped. Re-fetch hierarchy snapshot.`
            );
            return;
          }
          if (data.type === 'reconnect_needed') {
            setStreamError({ code: 'reconnect_needed', message: data.message });
            return;
          }
          if (data.type === 'events' && Array.isArray(data.events)) {
            setEventsList((prev) => {
              const combined = [...prev, ...data.events];
              // Retain max 200 events
              return combined.slice(-200);
            });
          }
        } catch {
          // JSON parse ignore
        }
      };

      ws.onerror = () => {
        setStreamStatus('error');
        setStreamError({
          code: 'ws_error',
          message: 'Accessibility events WebSocket stream error',
        });
      };

      ws.onclose = () => {
        setStreamStatus('disconnected');
      };
    } catch (err: unknown) {
      setStreamStatus('error');
      setStreamError({
        code: err instanceof ApiError ? err.code : 'ws_handshake_failed',
        message: err instanceof Error ? err.message : 'Failed to connect to events stream',
      });
    }
  };

  const handleStopStream = () => {
    if (eventsWsRef.current) {
      eventsWsRef.current.close();
      eventsWsRef.current = null;
    }
    setStreamStatus('disconnected');
  };

  // ==========================================
  // Cleanup on device change & unmount
  // ==========================================
  useEffect(() => {
    // When selectedDeviceId changes, close active WebSockets
    if (eventsWsRef.current) {
      eventsWsRef.current.close();
      eventsWsRef.current = null;
      setStreamStatus('disconnected');
    }
    if (replayWsRef.current) {
      replayWsRef.current.close();
      replayWsRef.current = null;
      setReplayStatus('idle');
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    return () => {
      if (eventsWsRef.current) {
        eventsWsRef.current.close();
        eventsWsRef.current = null;
      }
      if (replayWsRef.current) {
        replayWsRef.current.close();
        replayWsRef.current = null;
      }
    };
  }, []);

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
      data-testid="automation-tools-container"
    >
      {/* Header and Sub-navigation */}
      <div className="flex items-center gap-2">
        <Layers size={18} className="text-emerald" />
        <h2 className="text-sm font-semibold text-main">Automation Tools & Extension Services</h2>
      </div>

      {!showAll && <div className="stat-strip"><QuickStats items={showAll ? [
        { label: 'OCR status', value: ocrLoading ? 'Running' : ocrError ? 'Failed' : ocrResult ? 'Completed' : 'Not run' },
        { label: 'Matching status', value: matchLoading ? 'Running' : matchError ? 'Failed' : matchResult ? 'Completed' : 'Not run' },
        { label: 'Recording', value: activeRecordingId ? 'Active' : 'Stopped' },
        { label: 'Replay status', value: replayStatus },
        { label: 'Event stream', value: streamStatus },
      ] : activeTab === 'ocr' ? [
        { label: 'OCR status', value: ocrLoading ? 'Running' : ocrError ? 'Failed' : ocrResult ? 'Completed' : 'Not run' },
        { label: 'Text regions', value: ocrResult?.regions.length ?? '—' },
        { label: 'Characters', value: ocrResult?.text.length ?? '—' },
      ] : activeTab === 'match' ? [
        { label: 'Matching status', value: matchLoading ? 'Running' : matchError ? 'Failed' : matchResult ? 'Completed' : 'Not run' },
        { label: 'Matches', value: matchResult?.matches.length ?? '—' },
        { label: 'Score threshold', value: matchThreshold },
      ] : activeTab === 'recordings' ? [
        { label: 'Recording', value: activeRecordingId ? 'Active' : 'Stopped' },
        { label: 'Saved recordings', value: recordingsLoading ? 'Loading…' : recordingError ? 'Unavailable' : recordingsList.length },
        { label: 'Selected steps', value: selectedRecording?.steps.length ?? '—' },
      ] : activeTab === 'replay' ? [
        { label: 'Replay status', value: replayStatus },
        { label: 'Step progress', value: activeReplayId ? `${replayCurrentStep} / ${replayTotalSteps}` : '—' },
        { label: 'Reported events', value: replayEvents.length },
      ] : [
        { label: 'Event stream', value: streamStatus },
        { label: 'Buffered events', value: eventsList.length },
        { label: 'Sequence continuity', value: sequenceGapWarning ? 'Gap detected' : streamStatus === 'connected' ? 'No gaps reported' : 'Not assessed' },
      ]} /></div>}

      {/* Tabs */}
      {!hideNavigation && !showAll && <div className="flex items-center gap-2 border-b border-card pb-2 overflow-auto">
        <button
          type="button"
          onClick={() => setActiveTab('ocr')}
          className={`btn btn-sm ${activeTab === 'ocr' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="tab-ocr"
        >
          <FileText size={13} />
          <span>Host OCR</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('match')}
          className={`btn btn-sm ${activeTab === 'match' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="tab-match"
        >
          <Crosshair size={13} />
          <span>Template Match</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('recordings')}
          className={`btn btn-sm ${activeTab === 'recordings' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="tab-recordings"
        >
          <Disc size={13} />
          <span>Action Recordings</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('replay')}
          className={`btn btn-sm ${activeTab === 'replay' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="tab-replay"
        >
          <Play size={13} />
          <span>Action Replay</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('events')}
          className={`btn btn-sm ${activeTab === 'events' ? 'btn-primary' : 'btn-secondary'}`}
          data-testid="tab-events"
        >
          <Clock size={13} />
          <span>Accessibility Stream</span>
        </button>
      </div>}

      <div className={showAll ? 'automation-section-grid' : undefined}>
        {/* TAB 1: HOST OCR */}
        {(showAll || activeTab === 'ocr') && (
          <div className="flex flex-col gap-4" data-testid="ocr-section">
            {showAll && (() => { const st = ocrLoading ? 'Running' : ocrError ? 'Failed' : ocrResult ? 'Completed' : 'Not run'; return <ToolHead icon={<FileText size={15} />} title="Host OCR" status={st} tone={toneOf(st)} />; })()}
            <div className="text-xs text-dim">
              Host Tesseract OCR extracts text and bounding boxes from uploaded screenshots or images.
              Does not require an active Android device.
            </div>

            <form onSubmit={handleRunOcr} className="flex flex-col gap-3 tool-form">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-dim font-medium">Image File (PNG/JPEG)</label>
                  <FilePick file={ocrFile} placeholder="Choose a PNG or JPEG…">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleOcrFileChange}
                      className="file-pick-input"
                      data-testid="ocr-file-input"
                      disabled={ocrLoading}
                    />
                  </FilePick>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-dim font-medium">Language Code</label>
                  <input
                    type="text"
                    value={ocrLang}
                    onChange={(e) => setOcrLang(e.target.value)}
                    placeholder="e.g. eng, deu, spa"
                    className="input text-xs"
                    data-testid="ocr-language-input"
                    disabled={ocrLoading}
                  />
                </div>
              </div>

              {showAll && (
                <div className="tool-image-preview">
                  {ocrPreviewUrl ? <img src={ocrPreviewUrl} alt={ocrFile?.name ?? 'Selected image'} /> : <span>The chosen image previews here</span>}
                </div>
              )}

              <div className="tool-actions">
                <button
                  type="submit"
                  disabled={!ocrFile || ocrLoading}
                  className="btn btn-primary btn-sm"
                  data-testid="ocr-submit-button"
                >
                  {ocrLoading ? <RefreshCw size={13} className="animate-spin" /> : <FileText size={13} />}
                  <span>{ocrLoading ? 'Running OCR...' : 'Run Host OCR'}</span>
                </button>
              </div>
            </form>

            {/* OCR Error Display */}
            {ocrError && (
              <div className="alert alert-danger" data-testid="ocr-error">
                <AlertCircle size={16} />
                <div className="flex flex-col">
                  <span className="font-semibold">{ocrError.code || 'OCR Error'}</span>
                  <span>{ocrError.message}</span>
                </div>
              </div>
            )}

            {/* OCR Result Display */}
            {ocrResult && (
              <div className="flex flex-col gap-3" data-testid="ocr-result">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-main">Recognized Text</span>
                  <span className="badge badge-completed text-xs">
                    {ocrResult.regions?.length || 0} regions
                  </span>
                </div>

                <div
                  className="p-3 rounded font-mono text-xs bg-slate-900 border border-slate-800 text-main"
                  style={{ whiteSpace: 'pre-wrap', maxHeight: '160px', overflowY: 'auto' }}
                  data-testid="ocr-text-output"
                >
                  {ocrResult.text ? ocrResult.text : <span className="text-dim">(No text detected)</span>}
                </div>

                {ocrResult.regions && ocrResult.regions.length > 0 && (
                  <div className="table-container" style={{ maxHeight: '200px' }}>
                    <table className="table" data-testid="ocr-regions-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Text</th>
                          <th>Bounding Box [X, Y, W, H]</th>
                          <th>Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ocrResult.regions.map((reg, idx) => (
                          <tr key={idx}>
                            <td className="font-mono text-xs text-dim">{idx + 1}</td>
                            <td className="font-mono text-xs font-semibold text-main">{reg.text}</td>
                            <td className="font-mono text-xs text-muted">
                              [{reg.left}, {reg.top}, {reg.width}, {reg.height}]
                            </td>
                            <td className="font-mono text-xs text-emerald">
                              {reg.confidence.toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: TEMPLATE MATCHING */}
        {(showAll || activeTab === 'match') && (
          <div className="flex flex-col gap-4" data-testid="match-section">
            {showAll && (() => { const st = matchLoading ? 'Running' : matchError ? 'Failed' : matchResult ? 'Completed' : 'Not run'; return <ToolHead icon={<Crosshair size={15} />} title="Image Matching" status={st} tone={toneOf(st)} />; })()}
            <div className="text-xs text-dim">
              Normalized 2D Template Matching computes Zero-mean Normalized Cross Correlation (ZNCC)
              to locate needle templates in haystack images with non-maximum suppression.
            </div>

            <form onSubmit={handleRunMatch} className="flex flex-col gap-3 tool-form">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-dim font-medium">Source Image (Haystack)</label>
                  <FilePick file={matchSourceFile} placeholder="Screenshot to search in…">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        setMatchSourceFile(e.target.files?.[0] || null);
                        setMatchError(null);
                        setMatchResult(null);
                      }}
                      className="file-pick-input"
                      data-testid="match-source-input"
                      disabled={matchLoading}
                    />
                  </FilePick>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-dim font-medium">Template Needle</label>
                  <FilePick file={matchTemplateFile} placeholder="Image to find…">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        setMatchTemplateFile(e.target.files?.[0] || null);
                        setMatchError(null);
                        setMatchResult(null);
                      }}
                      className="file-pick-input"
                      data-testid="match-template-input"
                      disabled={matchLoading}
                    />
                  </FilePick>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-dim font-medium">Threshold (0.0 to 1.0)</label>
                  <input
                    type="number"
                    min="0.0"
                    max="1.0"
                    step="0.05"
                    value={matchThreshold}
                    onChange={(e) => setMatchThreshold(parseFloat(e.target.value) || 0.8)}
                    className="input text-xs"
                    data-testid="match-threshold-input"
                    disabled={matchLoading}
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-dim font-medium">Max Matches (1 to 100)</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={matchMaxMatches}
                    onChange={(e) => setMatchMaxMatches(parseInt(e.target.value, 10) || 10)}
                    className="input text-xs"
                    data-testid="match-max-matches-input"
                    disabled={matchLoading}
                  />
                </div>
              </div>

              <div className="tool-actions">
                <button
                  type="submit"
                  disabled={!matchSourceFile || !matchTemplateFile || matchLoading}
                  className="btn btn-primary btn-sm"
                  data-testid="match-submit-button"
                >
                  {matchLoading ? <RefreshCw size={13} className="animate-spin" /> : <Crosshair size={13} />}
                  <span>{matchLoading ? 'Finding Matches...' : 'Find Matches'}</span>
                </button>
              </div>
            </form>

            {/* Template Match Error Display */}
            {matchError && (
              <div className="alert alert-danger" data-testid="match-error">
                <AlertCircle size={16} />
                <div className="flex flex-col">
                  <span className="font-semibold">{matchError.code || 'Matching Error'}</span>
                  <span>{matchError.message}</span>
                </div>
              </div>
            )}

            {/* Template Match Results */}
            {matchResult && (
              <div className="flex flex-col gap-3" data-testid="match-result">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-main">Match Results</span>
                  <span className="badge badge-completed text-xs" data-testid="match-count-badge">
                    {matchResult.matches.length} matches found
                  </span>
                </div>

                {matchResult.matches.length === 0 ? (
                  <div className="inspect-empty">
                    No matches found above threshold {matchThreshold}.
                  </div>
                ) : (
                  <div className="table-container" style={{ maxHeight: '200px' }}>
                    <table className="table" data-testid="matches-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Coordinates [X, Y]</th>
                          <th>Dimensions [W × H]</th>
                          <th>Confidence Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matchResult.matches.map((item, idx) => (
                          <tr key={idx}>
                            <td className="font-mono text-xs text-dim">{idx + 1}</td>
                            <td className="font-mono text-xs font-semibold text-main">
                              [{item.x}, {item.y}]
                            </td>
                            <td className="font-mono text-xs text-muted">
                              {item.width} × {item.height}
                            </td>
                            <td className="font-mono text-xs text-emerald">
                              {(item.score * 100).toFixed(1)}% ({item.score.toFixed(4)})
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: ACTION RECORDINGS */}
        {(showAll || activeTab === 'recordings') && (
          <div className="flex flex-col gap-4" data-testid="recordings-section">
            {showAll && <ToolHead icon={<Disc size={15} />} title="Action Recordings" status={activeRecordingId ? 'Recording' : 'Stopped'} tone={activeRecordingId ? 'danger' : 'neutral'} />}
            <div className="text-xs text-dim">
              Records semantic user actions executed via the automation helper on the target device.
              Successful steps persist server-side in application data storage.
            </div>

            {!selectedDeviceId && (
              <div className="alert alert-warning" data-testid="no-device-warning">
                <AlertTriangle size={16} />
                <span>
                  No target device selected. Select an active device to start action recording.
                </span>
              </div>
            )}

            {/* Recording Error */}
            {recordingError && (
              <div className="alert alert-danger" data-testid="recording-error">
                <AlertCircle size={16} />
                <div className="flex flex-col">
                  <span className="font-semibold">{recordingError.code || 'Recording Error'}</span>
                  <span>{recordingError.message}</span>
                </div>
              </div>
            )}

            {/* Persisted Recordings List */}
            <div className="flex flex-col gap-2 tool-fill">
              <span className="tool-subhead">Persisted Server Recordings <span className="text-dim">{recordingsList.length}</span></span>
              {recordingsList.length === 0 ? (
                <div className="inspect-empty">
                  {recordingsLoading ? 'Loading recordings...' : 'No persisted recordings found.'}
                </div>
              ) : (
                <div className="table-container" style={{ maxHeight: '180px' }}>
                  <table className="table" data-testid="recordings-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Device ID</th>
                        <th>Steps</th>
                        <th>Created At</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recordingsList.map((rec) => (
                        <tr key={rec.id}>
                          <td className="font-medium text-xs text-main font-mono">
                            {rec.name || rec.id.slice(0, 8)}
                          </td>
                          <td className="font-mono text-xs text-muted">{rec.deviceId}</td>
                          <td className="font-mono text-xs text-emerald">
                            {rec.steps?.length || 0} steps
                          </td>
                          <td className="text-xs text-dim">
                            {new Date(rec.startedAt).toLocaleString()}
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleViewRecording(rec.id)}
                                className="btn btn-ghost btn-sm text-xs"
                                data-testid={`view-recording-${rec.id}`}
                                title="View Steps"
                              >
                                <Eye size={12} />
                                <span>View</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setReplayRecordingId(rec.id);
                                  setActiveTab('replay');
                                }}
                                className="btn btn-secondary btn-sm text-xs"
                                data-testid={`replay-link-${rec.id}`}
                                title="Load into Replay"
                              >
                                <Play size={12} className="text-emerald" />
                                <span>Replay</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Selected Recording Step Inspection */}
            {selectedRecording && (
              <div
                className="flex flex-col gap-2 p-3 rounded bg-slate-900 border border-slate-800"
                data-testid="selected-recording-steps"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-main">
                      Step Sequence: {selectedRecording.name || selectedRecording.id}
                    </span>
                    <span className="badge badge-neutral text-xs">
                      {selectedRecording.steps?.length || 0} steps
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setReplayRecordingId(selectedRecording.id);
                      setActiveTab('replay');
                    }}
                    className="btn btn-primary btn-sm text-xs"
                    data-testid="load-selected-to-replay-btn"
                  >
                    <Play size={12} />
                    <span>Replay This Sequence</span>
                  </button>
                </div>

                {selectedRecording.steps?.length === 0 ? (
                  <div className="text-xs text-dim p-2">
                    No successful steps recorded in this session.
                  </div>
                ) : (
                  <div className="table-container" style={{ maxHeight: '180px' }}>
                    <table className="table automation-detail-table" data-testid="recorded-steps-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Action</th>
                          <th>Selector</th>
                          <th>Parameters</th>
                          <th>Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRecording.steps.map((st, idx) => (
                          <tr key={idx}>
                            <td className="font-mono text-xs text-dim">{idx + 1}</td>
                            <td className="font-mono text-xs font-semibold text-emerald">
                              {st.action}
                            </td>
                            <td className="font-mono text-xs text-muted">
                              <div>
                                {typeof st.selector === 'object'
                                  ? JSON.stringify(st.selector)
                                  : String(st.selector)}
                              </div>
                            </td>
                            <td className="font-mono text-xs text-dim">
                              {st.text && `text="${st.text}" `}
                              {st.direction && `direction="${st.direction}" `}
                              {st.condition && `condition="${st.condition}" `}
                            </td>
                            <td className="font-mono text-xs text-dim">{st.durationMs}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            {/* Recorder Controls */}
            <div className="tool-recorder tool-actions">
              {!activeRecordingId ? (
                <div className="tool-recorder-start">
                  <input
                    type="text"
                    placeholder="Recording Name (optional)"
                    value={recordingName}
                    onChange={(e) => setRecordingName(e.target.value)}
                    className="input text-xs"
                    data-testid="recording-name-input"
                    disabled={!selectedDeviceId || recordingActionLoading}
                  />
                  <button
                    type="button"
                    onClick={handleStartRecording}
                    disabled={!selectedDeviceId || recordingActionLoading}
                    className="btn btn-primary btn-sm"
                    data-testid="start-recording-btn"
                  >
                    <Disc size={13} className="text-danger" />
                    <span>Start Recording</span>
                  </button>
                </div>
              ) : (
                <div className="tool-recording-live">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-danger animate-pulse">RECORDING ACTIVE</span>
                    <span className="font-mono text-main">{activeRecordingDeviceId}</span>
                    <span className="text-dim">ID: {activeRecordingId}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleStopRecording}
                    disabled={recordingActionLoading}
                    className="btn btn-danger btn-sm"
                    data-testid="stop-recording-btn"
                  >
                    <Square size={13} />
                    <span>Stop & Save Recording</span>
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={loadRecordings}
                disabled={recordingsLoading}
                className="btn btn-secondary btn-sm"
                data-testid="refresh-recordings-btn"
                title="Refresh recordings"
                aria-label="Refresh recordings"
              >
                <RefreshCw size={13} className={recordingsLoading ? 'animate-spin' : ''} />
              </button>
            </div>

          </div>
        )}

        {/* TAB 4: ACTION REPLAY */}
        {(showAll || activeTab === 'replay') && (
          <div className="flex flex-col gap-4" data-testid="replay-section">
            {showAll && <ToolHead icon={<Play size={15} />} title="Action Replay" status={replayStatus === 'idle' ? 'Idle' : replayStatus} tone={toneOf(replayStatus)} />}
            <div className="text-xs text-dim">
              Executes recorded step sequences sequentially against the device's automation helper
              with live progress streaming over WebSocket.
            </div>

            {!selectedDeviceId && (
              <div className="alert alert-warning" data-testid="replay-no-device-warning">
                <AlertTriangle size={16} />
                <span>Select an active device to replay action sequences.</span>
              </div>
            )}

            <div className="flex flex-col gap-3 tool-form">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-dim font-medium">Select Recording to Replay</label>
                <select
                  value={replayRecordingId}
                  onChange={(e) => setReplayRecordingId(e.target.value)}
                  className="select text-xs font-mono"
                  data-testid="replay-recording-select"
                  disabled={replayStatus === 'running' || replayLoading}
                >
                  <option value="">-- Choose Recording --</option>
                  {recordingsList.map((rec) => (
                    <option key={rec.id} value={rec.id}>
                      {rec.name ? `${rec.name} (${rec.id.slice(0, 8)})` : rec.id} - {rec.steps?.length || 0} steps
                    </option>
                  ))}
                </select>
              </div>

              <div className="tool-actions">
                <button
                  type="button"
                  onClick={handleStartReplay}
                  disabled={!selectedDeviceId || !replayRecordingId || replayStatus === 'running' || replayLoading}
                  className="btn btn-primary btn-sm"
                  data-testid="start-replay-btn"
                >
                  {replayLoading ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
                  <span>Start Replay</span>
                </button>

                <button
                  type="button"
                  onClick={handleCancelReplay}
                  disabled={replayStatus !== 'running' || !activeReplayId || replayLoading}
                  className="btn btn-danger btn-sm"
                  data-testid="cancel-replay-btn"
                >
                  <Square size={13} />
                  <span>Cancel Replay</span>
                </button>
              </div>
            </div>

            {/* Replay Status Banner */}
            {replayStatus !== 'idle' && (
              <div className="tool-replay-status">
                <div className="flex items-center gap-2">
                  <span
                    className={`badge ${replayStatus === 'running'
                        ? 'badge-running animate-pulse'
                        : replayStatus === 'completed'
                          ? 'badge-completed'
                          : replayStatus === 'cancelled'
                            ? 'badge-cancelled'
                            : 'badge-danger'
                      }`}
                    data-testid="replay-status-badge"
                  >
                    {replayStatus.toUpperCase()}
                  </span>
                  <span className="text-dim">
                    Step {replayCurrentStep} of {replayTotalSteps}
                  </span>
                </div>

                {replayTotalSteps > 0 && (
                  <div
                    className="tool-progress"
                    data-testid="replay-progress-bar"
                  >
                    <div
                      className="tool-progress-fill"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round((replayCurrentStep / replayTotalSteps) * 100)
                        )}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Replay Error */}
            {replayError && (
              <div className="alert alert-danger" data-testid="replay-error">
                <AlertCircle size={16} />
                <div className="flex flex-col">
                  <span className="font-semibold">{replayError.code || 'Replay Error'}</span>
                  <span>{replayError.message}</span>
                </div>
              </div>
            )}

            {/* Replay Events Stream Log */}
            {replayEvents.length > 0 && (
              <div className="table-container" style={{ maxHeight: '200px' }}>
                <table className="table" data-testid="replay-events-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Action</th>
                      <th>Status</th>
                      <th>Duration</th>
                      <th>Error Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {replayEvents.map((evt, idx) => (
                      <tr key={idx}>
                        <td className="font-mono text-xs text-dim">
                          {evt.stepIndex !== undefined ? evt.stepIndex + 1 : '-'}
                        </td>
                        <td className="font-mono text-xs font-semibold text-main">
                          {evt.action || '-'}
                        </td>
                        <td>
                          <span
                            className={`badge ${evt.status === 'passed'
                                ? 'badge-completed'
                                : evt.status === 'started'
                                  ? 'badge-running'
                                  : evt.status === 'failed'
                                    ? 'badge-danger'
                                    : 'badge-neutral'
                              }`}
                          >
                            {evt.status}
                          </span>
                        </td>
                        <td className="font-mono text-xs text-dim">
                          {evt.durationMs !== undefined ? `${evt.durationMs}ms` : '-'}
                        </td>
                        <td className="font-mono text-xs text-danger">
                          {evt.error || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 5: ACCESSIBILITY EVENTS STREAM */}
        {(showAll || activeTab === 'events') && (
          <div className="flex flex-col gap-4" data-testid="events-section">
            {showAll && <ToolHead icon={<Clock size={15} />} title="Accessibility Events" />}
            <div className="text-xs text-dim">
              Streams real-time accessibility events from the helper on the target device via
              WebSocket. Retains the latest 200 events in memory with sequence gap detection.
            </div>

            {!selectedDeviceId && (
              <div className="alert alert-warning" data-testid="events-no-device-warning">
                <AlertTriangle size={16} />
                <span>Select an active device to stream accessibility events.</span>
              </div>
            )}

            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                {streamStatus === 'disconnected' || streamStatus === 'error' ? (
                  <button
                    type="button"
                    onClick={handleStartStream}
                    disabled={!selectedDeviceId}
                    className="btn btn-primary btn-sm"
                    data-testid="start-stream-btn"
                  >
                    <Play size={13} />
                    <span>Start Live Stream</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleStopStream}
                    className="btn btn-danger btn-sm"
                    data-testid="stop-stream-btn"
                  >
                    <Square size={13} />
                    <span>Stop Stream</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setEventsList([]);
                    setSequenceGapWarning(null);
                  }}
                  disabled={eventsList.length === 0}
                  className="btn btn-secondary btn-sm"
                  data-testid="clear-events-btn"
                >
                  <span>Clear</span>
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`badge ${streamStatus === 'connected'
                      ? 'badge-online'
                      : streamStatus === 'connecting'
                        ? 'badge-running'
                        : streamStatus === 'error'
                          ? 'badge-danger'
                          : 'badge-neutral'
                    }`}
                  data-testid="stream-status-badge"
                >
                  {streamStatus.toUpperCase()}
                </span>
                <span className="text-dim font-mono" data-testid="event-count-indicator">
                  {eventsList.length} / 200 retained
                </span>
              </div>
            </div>

            {/* Sequence Gap Warning */}
            {sequenceGapWarning && (
              <div className="alert alert-warning" data-testid="sequence-gap-alert">
                <AlertTriangle size={16} />
                <div className="flex flex-col">
                  <span className="font-semibold">Event Buffer Sequence Gap</span>
                  <span>{sequenceGapWarning}</span>
                </div>
              </div>
            )}

            {/* Stream Error Display */}
            {streamError && (
              <div className="alert alert-danger" data-testid="stream-error">
                <AlertCircle size={16} />
                <div className="flex flex-col">
                  <span className="font-semibold">{streamError.code || 'Stream Error'}</span>
                  <span>{streamError.message}</span>
                </div>
              </div>
            )}

            {/* Events Stream Table */}
            <div className="table-container" style={{ maxHeight: '260px' }}>
              <table className="table automation-detail-table" data-testid="accessibility-events-table">
                <thead>
                  <tr>
                    <th>Seq</th>
                    <th>Event Type</th>
                    <th>Package Name</th>
                    <th>Class</th>
                    <th>Text / Description</th>
                  </tr>
                </thead>
                <tbody>
                  {eventsList.length === 0 ? (
                    <tr className="table-empty-row">
                      <td colSpan={5} className="text-dim text-center py-4">
                        {streamStatus === 'connected'
                          ? 'Listening for accessibility events from device...'
                          : 'No events received yet. Start stream to receive live events.'}
                      </td>
                    </tr>
                  ) : (
                    eventsList.map((item, idx) => {
                      const seq = item.sequence !== undefined ? String(item.sequence) : String(idx + 1);
                      const eventType = String(item.eventType || item.type || 'EVENT');
                      const pkg = String(item.packageName || '-');
                      const cls = String(item.className || '-');
                      const text = String(
                        item.text || item.contentDescription || item.message || ''
                      );

                      return (
                        <tr key={idx}>
                          <td className="font-mono text-xs text-dim">{seq}</td>
                          <td className="font-mono text-xs font-semibold text-emerald">
                            {eventType}
                          </td>
                          <td className="font-mono text-xs text-muted">
                            <div>{pkg}</div>
                          </td>
                          <td className="font-mono text-xs text-dim">
                            <div>{cls}</div>
                          </td>
                          <td className="font-mono text-xs text-main">
                            <div>{text || '-'}</div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
