import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import { useDeviceStats } from '../lib/useDeviceStats.js';
import { sectionText } from '../lib/inspectionStats.js';
import React, { useEffect, useRef, useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { OperationCardList } from '../components/OperationCardList.js';
import {
  mediaApi,
  mapCanvasCoordinates,
  ScreenCanvasRecorder,
  ScrcpyClient,
  MediaCapabilities,
  RecordingResult,
} from '../lib/media/index.js';
import {
  AndroidMotionEventAction,
  AndroidMotionEventButton,
} from '@yume-chan/scrcpy';
import {
  AlertCircle,
  Camera,
  CheckCircle,
  Clipboard,
  Download,
  Eye,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Play,
  Power,
  RotateCw,
  Send,
  Sliders,
  Smartphone,
  Square,
  Video,
  Volume2,
  VolumeX,
} from 'lucide-react';

export const ScreenPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('screen', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    runOperation,
  } = useWorkstation();

  // Canvas & Client refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scrcpyClientRef = useRef<ScrcpyClient | null>(null);
  const recorderRef = useRef<ScreenCanvasRecorder | null>(null);

  // Mirror Session State
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [mirrorStarting, setMirrorStarting] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [streamMeta, setStreamMeta] = useState<{
    width?: number;
    height?: number;
    codec?: string;
    deviceName?: string;
  } | null>(null);

  // Configuration options
  const [selectedCodec, setSelectedCodec] = useState<'h264' | 'h265' | 'av1'>('h264');
  const [maxSize, setMaxSize] = useState<number>(0);
  const [maxFps, setMaxFps] = useState<number>(60);
  const [audioEnabled, setAudioEnabled] = useState<boolean>(false);
  const [stayAwake, setStayAwake] = useState<boolean>(true);

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [lastRecording, setLastRecording] = useState<RecordingResult | null>(null);

  // Screenshot State
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  // Text & Clipboard Input
  const [inputText, setInputText] = useState('');
  const [clipboardText, setClipboardText] = useState('');
  const [lastDeviceClipboard, setLastDeviceClipboard] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const screenStats = useDeviceStats('screen', selectedDeviceId, 30000, { enabled: activeTab !== 'operations' });
  const displaySize = sectionText(screenStats.stats?.sections?.size)?.split('\n').slice(-1)[0]?.replace(/^.*size:\s*/, '') ?? null;
  const displayDensity = sectionText(screenStats.stats?.sections?.density)?.split('\n').slice(-1)[0]?.replace(/^.*density:\s*/, '') ?? null;

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Fullscreen Zoom State & Handler
  const [isFullscreen, setIsFullscreen] = useState(false);
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);

  const toggleFullScreen = async () => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      if (viewerContainerRef.current?.requestFullscreen) {
        try {
          await viewerContainerRef.current.requestFullscreen();
        } catch {
          // Handled via CSS fullscreen fallback
        }
      }
    } else {
      setIsFullscreen(false);
      if (document.fullscreenElement && document.exitFullscreen) {
        try {
          await document.exitFullscreen();
        } catch {
          // ignore
        }
      }
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
        setIsFullscreen(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('keydown', handleKeyDown);
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, [isFullscreen]);

  // System Capabilities State
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const isWebCodecsAvailable = typeof window !== 'undefined' && ScrcpyClient.isWebCodecsSupported();
  const isAudioAvailable = typeof window !== 'undefined' && ScrcpyClient.isAudioSupported();

  // Fetch capabilities on mount
  useEffect(() => {
    mediaApi
      .getCapabilities()
      .then(setCapabilities)
      .catch((err) => console.warn('Could not fetch media capabilities:', err));
  }, []);

  // Cleanup session on unmount or device switch
  useEffect(() => {
    return () => {
      stopMirrorSession();
    };
  }, [selectedDeviceId]);

  // Recording timer
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    if (isRecording) {
      timer = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordingSeconds(0);
    }
    return () => clearInterval(timer);
  }, [isRecording]);

  // Start Scrcpy Mirror Session
  const startMirrorSession = async () => {
    if (!selectedDeviceId) return;
    setMirrorStarting(true);
    setMirrorError(null);

    let createdId: string | null = null;
    try {
      // 1. Create session via backend
      const session = await mediaApi.createSession({
        deviceId: selectedDeviceId,
        videoCodec: selectedCodec,
        maxSize: maxSize > 0 ? maxSize : undefined,
        maxFps,
        audio: audioEnabled,
        stayAwake,
      });

      createdId = session.id;
      setActiveSessionId(session.id);

      // 2. Initialize Scrcpy client with canvas
      if (canvasRef.current) {
        const client = new ScrcpyClient(session, canvasRef.current, {
          onMetadata: (meta) => {
            setStreamMeta(meta);
          },
          onClipboard: (text) => {
            setLastDeviceClipboard(text);
          },
          onError: (err) => {
            console.error('Mirror error:', err);
            setMirrorError(err.message);
          },
          onClose: () => {
            stopMirrorSession();
          },
        });

        scrcpyClientRef.current = client;
        await client.start();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to launch mirror session';
      setMirrorError(msg);
      scrcpyClientRef.current?.dispose();
      scrcpyClientRef.current = null;
      if (createdId) { try { await mediaApi.deleteSession(createdId); } catch {} }
      setActiveSessionId(null);
    } finally {
      setMirrorStarting(false);
    }
  };

  // Stop Scrcpy Mirror Session
  const stopMirrorSession = async () => {
    if (recorderRef.current) {
      if (isRecording) {
        try {
          await handleStopRecording();
        } catch {
          // ignore
        }
      }
      recorderRef.current.cleanup();
      recorderRef.current = null;
    }

    if (scrcpyClientRef.current) {
      scrcpyClientRef.current.dispose();
      scrcpyClientRef.current = null;
    }

    if (activeSessionId) {
      const id = activeSessionId;
      setActiveSessionId(null);
      try {
        await mediaApi.deleteSession(id);
      } catch {
        // ignore
      }
    }

    setStreamMeta(null);
  };

  // Pointer event handlers for Canvas interaction
  const isPointerDownRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!scrcpyClientRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.setPointerCapture(e.pointerId);
    isPointerDownRef.current = true;

    const { x, y } = mapCanvasCoordinates(
      canvas,
      e.clientX,
      e.clientY,
      scrcpyClientRef.current.videoWidth,
      scrcpyClientRef.current.videoHeight
    );

    scrcpyClientRef.current.injectTouch(
      AndroidMotionEventAction.Down,
      x,
      y,
      e.pressure || 1.0,
      AndroidMotionEventButton.Primary
    );
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPointerDownRef.current || !scrcpyClientRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;

    const { x, y } = mapCanvasCoordinates(
      canvas,
      e.clientX,
      e.clientY,
      scrcpyClientRef.current.videoWidth,
      scrcpyClientRef.current.videoHeight
    );

    scrcpyClientRef.current.injectTouch(
      AndroidMotionEventAction.Move,
      x,
      y,
      e.pressure || 1.0,
      AndroidMotionEventButton.Primary
    );
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isPointerDownRef.current || !scrcpyClientRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;
    isPointerDownRef.current = false;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const { x, y } = mapCanvasCoordinates(
      canvas,
      e.clientX,
      e.clientY,
      scrcpyClientRef.current.videoWidth,
      scrcpyClientRef.current.videoHeight
    );

    scrcpyClientRef.current.injectTouch(
      AndroidMotionEventAction.Up,
      x,
      y,
      0,
      AndroidMotionEventButton.Primary
    );
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!scrcpyClientRef.current || !canvasRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;

    const { x, y } = mapCanvasCoordinates(
      canvas,
      e.clientX,
      e.clientY,
      scrcpyClientRef.current.videoWidth,
      scrcpyClientRef.current.videoHeight
    );

    // Normalize wheel delta (-1 to 1)
    const scrollX = Math.max(-1, Math.min(1, -e.deltaX / 100));
    const scrollY = Math.max(-1, Math.min(1, -e.deltaY / 100));

    scrcpyClientRef.current.injectScroll(x, y, scrollX, scrollY);
  };

  // Browser Screen Recording
  const handleStartRecording = () => {
    if (!canvasRef.current) return;
    try {
      const audioTrack = scrcpyClientRef.current?.recordedAudioTrack;
      const recorder = new ScreenCanvasRecorder();
      recorder.start(canvasRef.current, maxFps || 30, audioTrack, {
        onAutoStop: (result) => {
          setIsRecording(false);
          setLastRecording(result);
          recorder.download(result);
        },
        onError: (err) => {
          console.error('Recording error:', err);
          setIsRecording(false);
        },
      });
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (err: unknown) {
      setMirrorError(err instanceof Error ? err.message : 'Could not start screen recording');
    }
  };

  const stoppingRecordingRef = useRef(false);
  const handleStopRecording = async () => {
    if (!recorderRef.current || stoppingRecordingRef.current) return;
    stoppingRecordingRef.current = true;
    try {
      const result = await recorderRef.current.stop();
      setIsRecording(false);
      setLastRecording(result);
      recorderRef.current.download(result);
    } catch (err: unknown) {
      console.error('Error stopping recording:', err);
      setMirrorError(err instanceof Error ? err.message : 'Failed to stop screen recording');
      setIsRecording(false);
    } finally {
      stoppingRecordingRef.current = false;
    }
  };

  // Hardware / Remote Key Injection
  const handleSendKey = async (keyCode: number) => {
    if (scrcpyClientRef.current) {
      scrcpyClientRef.current.injectKeyCode(keyCode);
      return;
    }

    if (!selectedDeviceId) return;
    const op = findOperation('V09') || findOperation('input_keyevent');
    if (op) {
      await runOperation(op.id, { keycode: String(keyCode) });
    }
  };

  // Text Injection
  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText) return;

    if (scrcpyClientRef.current) {
      scrcpyClientRef.current.injectText(inputText);
      setInputText('');
      return;
    }

    if (!selectedDeviceId) return;
    const op = findOperation('V11') || findOperation('input_text');
    if (op) {
      await runOperation(op.id, { text: inputText });
    }
    setInputText('');
  };

  // Clipboard Sync
  const handleSetClipboard = () => {
    if (!clipboardText) return;
    if (scrcpyClientRef.current) {
      scrcpyClientRef.current.setClipboard(clipboardText, false);
      showToast('Clipboard sent to device');
    } else {
      const op = findOperation('V15');
      if (op) {
        runOperation(op.id, { text: clipboardText });
      }
    }
  };

  // Take Screenshot (Preserved & always functional)
  const handleTakeScreenshot = async () => {
    if (!selectedDeviceId) return;
    setScreenshotLoading(true);
    setScreenshotError(null);

    try {
      const result = await mediaApi.captureScreen(selectedDeviceId);
      setScreenshotUrl(result.dataUrl);
    } catch (err: unknown) {
      setScreenshotError(err instanceof Error ? err.message : 'Screenshot capture failed');
    } finally {
      setScreenshotLoading(false);
    }
  };

  const isMirrorActive = activeSessionId !== null;

  return (
    <div className="workspace-page screen-page">
      <PageHeader
        title="Screen, Display & Media Interaction"
        description="Real-time Scrcpy 3.3.1 screen mirror, hardware touch/keyboard injection, canvas recording & display capture"
        actions={
          <>
            {capabilities?.scrcpyServer?.available ? (
              <span className="badge badge-success text-xs">
                <CheckCircle size={10} className="mr-1 inline" />
                scrcpy-server {capabilities.scrcpyServer.version}
              </span>
            ) : (
              <span className="badge badge-warning text-xs">
                <AlertCircle size={10} className="mr-1 inline" />
                scrcpy server unavailable
              </span>
            )}

            {isWebCodecsAvailable ? (
              <span className="badge badge-neutral text-xs">WebCodecs (HW Decoded)</span>
            ) : (
              <span className="badge badge-warning text-xs">No WebCodecs</span>
            )}
          </>
        }
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      {toastMessage && (
        <div className="alert alert-success text-xs flex items-center gap-2">
          <CheckCircle size={14} />
          <span>{toastMessage}</span>
        </div>
      )}

      {mirrorError && (
        <div className="alert alert-danger text-xs">
          <AlertCircle size={14} />
          <span>{mirrorError}</span>
        </div>
      )}

      <PageTabs page="screen" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <div className="screen-workspace-grid">
            <div
              ref={viewerContainerRef}
              className={`workspace-panel screen-viewer ${isFullscreen ? 'device-viewer-fullscreen' : ''}`}
            >
              {/* Header Controls */}
              <div className="flex items-center justify-between gap-2 viewer-header">
                <div className="flex items-center gap-2 min-w-0">
                  <MonitorPlay size={16} className="text-emerald flex-shrink-0" />
                  <span className="text-sm font-semibold text-main truncate">
                    {isMirrorActive ? 'Live Device Display Mirror' : 'Device Display Viewer'}
                  </span>
                  {isMirrorActive && (
                    <span className="badge badge-success text-xs font-mono animate-pulse">LIVE</span>
                  )}
                  {isFullscreen && streamMeta && (
                    <span className="text-xs text-dim font-mono hidden sm:inline">
                      {streamMeta.width}x{streamMeta.height} · {streamMeta.codec}
                    </span>
                  )}
                </div>

                {isFullscreen && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(4)}
                      title="Back (KEYCODE_BACK)"
                      disabled={!selectedDeviceId}
                    >
                      <span>Back</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(3)}
                      title="Home (KEYCODE_HOME)"
                      disabled={!selectedDeviceId}
                    >
                      <span>Home</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(187)}
                      title="Overview (KEYCODE_APP_SWITCH)"
                      disabled={!selectedDeviceId}
                    >
                      <span>Overview</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        if (scrcpyClientRef.current) {
                          scrcpyClientRef.current.rotateDevice();
                        }
                      }}
                      disabled={!isMirrorActive}
                      title="Rotate device display"
                    >
                      <RotateCw size={12} />
                      <span>Rotate</span>
                    </button>
                  </div>
                )}

                <div className="mirror-actions flex items-center gap-2">
                  {isMirrorActive ? (
                    <>
                      {isRecording ? (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={handleStopRecording}
                          title="Stop recording and download recording file"
                        >
                          <Square size={12} />
                          <span>
                            Stop Rec ({Math.floor(recordingSeconds / 60)}:
                            {String(recordingSeconds % 60).padStart(2, '0')})
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handleStartRecording}
                          title="Record live decoded canvas stream in browser"
                        >
                          <Video size={12} />
                          <span>Record Mirror</span>
                        </button>
                      )}

                      <button type="button" className="btn btn-danger btn-sm" onClick={stopMirrorSession}>
                        <Square size={12} />
                        <span>Disconnect</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={startMirrorSession}
                        disabled={mirrorStarting || !selectedDeviceId}
                      >
                        <Play size={12} />
                        <span>{mirrorStarting ? 'Launching...' : 'Start Mirror'}</span>
                      </button>

                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleTakeScreenshot}
                        disabled={screenshotLoading || !selectedDeviceId}
                      >
                        <Camera size={12} />
                        <span>{screenshotLoading ? 'Capturing...' : 'Capture Snapshot'}</span>
                      </button>
                    </>
                  )}

                  {/* Zoom Button */}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={toggleFullScreen}
                    title={isFullscreen ? 'Exit Full Screen (Esc)' : 'Zoom to full screen for higher quality control and view'}
                    aria-label={isFullscreen ? 'Exit Full Screen' : 'Zoom to Full Screen'}
                  >
                    {isFullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                    <span>{isFullscreen ? 'Exit Full Screen' : 'Zoom'}</span>
                  </button>
                </div>
              </div>

              {/* Canvas / Snapshot Box */}
              <div
                className="device-viewer-canvas-box"
                style={{
                  height: isFullscreen ? 'calc(100vh - 72px)' : undefined,
                  backgroundColor: '#070b14',
                  borderRadius: isFullscreen ? 0 : '6px',
                  border: isFullscreen ? 'none' : '1px solid var(--border-card)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                  position: 'relative',
                  userSelect: 'none',
                  touchAction: 'none',
                  flex: isFullscreen ? '1 1 0%' : undefined,
                }}
              >
                {/* Live WebGL / WebCodecs Canvas */}
                <canvas
                  ref={canvasRef}
                  style={{
                    display: isMirrorActive ? 'block' : 'none',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    cursor: 'crosshair',
                  }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerUp}
                  onWheel={handleWheel}
                />

                {/* Offline Snapshot Display (when mirror is not active) */}
                {!isMirrorActive && (
                  <>
                    {screenshotUrl ? (
                      <img
                        src={screenshotUrl}
                        alt="Device Display Screenshot"
                        style={{
                          maxHeight: '100%',
                          maxWidth: '100%',
                          objectFit: 'contain',
                        }}
                      />
                    ) : (
                      <div className="empty-state">
                        <Smartphone size={40} className="text-dim" />
                        <div className="text-xs text-dim text-center mt-2">
                          {screenshotLoading
                            ? 'Capturing framebuffer from device...'
                            : 'Click "Start Mirror" for interactive control or "Capture Snapshot" for static frame'}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* Download Buttons on Canvas */}
                {screenshotUrl && !isMirrorActive && (
                  <a
                    href={screenshotUrl}
                    download="device-screenshot.png"
                    className="btn btn-secondary btn-sm absolute"
                    style={{ bottom: '12px', right: '12px' }}
                  >
                    <Download size={12} />
                    <span>Download PNG</span>
                  </a>
                )}

                {lastRecording && (
                  <button
                    className="btn btn-secondary btn-sm absolute"
                    style={{ bottom: '12px', left: '12px' }}
                    onClick={() => {
                      const rec = new ScreenCanvasRecorder();
                      rec.download(lastRecording);
                    }}
                  >
                    <Download size={12} />
                    <span>Save Last Recording ({Math.round(lastRecording.sizeBytes / 1024)} KB)</span>
                  </button>
                )}
              </div>

              {/* Stream Metadata footer */}
              {streamMeta && (
                <div className="text-xs text-dim flex items-center justify-between px-1">
                  <span>Device: {streamMeta.deviceName || selectedDeviceId}</span>
                  <span>
                    Res: {streamMeta.width}x{streamMeta.height} | Codec: {streamMeta.codec}
                  </span>
                </div>
              )}

              {screenshotError && (
                <div className="alert alert-danger text-xs">{screenshotError}</div>
              )}
            </div>
            <div className="screen-control-stack">
              <div className="workspace-panel screen-telemetry-bar" role="status" aria-label="Screen session status">
                <div className="screen-telemetry-items">
                  <div className="screen-telemetry-item">
                    <span>Mirror</span>
                    <strong className={isMirrorActive ? 'text-emerald' : 'text-muted'}>{isMirrorActive ? 'Live' : mirrorStarting ? 'Starting…' : 'Stopped'}</strong>
                  </div>
                  <div className="screen-telemetry-item">
                    <span>Transport</span>
                    <strong>{isMirrorActive ? 'Mirror' : 'ADB'}</strong>
                  </div>
                  <div className="screen-telemetry-item">
                    <span>Recording</span>
                    <strong className={isRecording ? 'text-danger' : 'text-muted'}>{isRecording ? `${recordingSeconds}s` : lastRecording ? `${Math.round(lastRecording.sizeBytes / 1024)} KiB` : 'Idle'}</strong>
                  </div>
                  <div className="screen-telemetry-item">
                    <span>Display</span>
                    <strong className={!displaySize ? 'text-dim' : undefined}>
                      {streamMeta?.width && streamMeta?.height
                        ? `${streamMeta.width}×${streamMeta.height}`
                        : displaySize
                          ? `${displaySize}${displayDensity ? ` · ${displayDensity} dpi` : ''}`
                          : 'Unavailable'}
                    </strong>
                  </div>
                  {lastDeviceClipboard !== null && (
                    <div className="screen-telemetry-item">
                      <span>Clipboard</span>
                      <strong>{lastDeviceClipboard.length} chars</strong>
                    </div>
                  )}
                </div>
                <div className="screen-telemetry-meta">
                  <span className="text-xs text-dim">
                    {screenStats.error
                      ? `Display stats unavailable${screenStats.stats ? ' · stale' : ''}`
                      : screenStats.loading
                        ? 'Reading display…'
                        : screenStats.stats
                          ? `Collected ${new Date(screenStats.stats.collectedAt).toLocaleTimeString()}`
                          : selectedDeviceId
                            ? 'Ready'
                            : 'No device'}
                  </span>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={!selectedDeviceId || screenStats.loading} onClick={screenStats.refresh}>Refresh</button>
                </div>
              </div>
              <div className="workspace-panel"><div className="flex items-center gap-2">
                <Sliders size={16} className="text-emerald" />
                <h2 className="panel-title">Hardware Navigation & System Keys</h2>
              </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-dim font-medium uppercase tracking-wider">
                    Navigation &amp; System Keys
                  </label>
                  <div className="key-row">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(3)} // KEYCODE_HOME
                      disabled={!selectedDeviceId}
                    >
                      <span>Home</span>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(4)} // KEYCODE_BACK
                      disabled={!selectedDeviceId}
                    >
                      <span>Back</span>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm key-wide"
                      onClick={() => handleSendKey(187)} // KEYCODE_APP_SWITCH
                      disabled={!selectedDeviceId}
                    >
                      <span>Overview (Apps)</span>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(26)} // KEYCODE_POWER
                      disabled={!selectedDeviceId}
                    >
                      <Power size={12} className="text-danger" />
                      <span>Power</span>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(24)} // KEYCODE_VOLUME_UP
                      disabled={!selectedDeviceId}
                    >
                      <Volume2 size={12} />
                      <span>Vol +</span>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSendKey(25)} // KEYCODE_VOLUME_DOWN
                      disabled={!selectedDeviceId}
                    >
                      <VolumeX size={12} />
                      <span>Vol -</span>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        if (scrcpyClientRef.current) {
                          scrcpyClientRef.current.rotateDevice();
                        }
                      }}
                      disabled={!isMirrorActive}
                      title="Rotate device display"
                    >
                      <RotateCw size={12} />
                      <span>Rotate</span>
                    </button>
                  </div>
                </div>
                <form onSubmit={handleSendText} className="flex flex-col gap-1.5 pt-2 border-t border-slate-800">
                  <label className="text-xs text-dim font-medium">Inject Text String</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      className="input text-xs font-mono flex-1"
                      placeholder="Type text to send directly to focused input..."
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="btn btn-secondary btn-sm"
                      disabled={!inputText || !selectedDeviceId}
                    >
                      <Send size={12} />
                      <span>Send</span>
                    </button>
                  </div>
                </form>
                <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-800">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-dim font-medium">Clipboard Synchronization</label>
                    {lastDeviceClipboard && (
                      <span className="text-xs text-emerald truncate max-w-[200px]">
                        Device: {lastDeviceClipboard}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      className="input text-xs font-mono flex-1"
                      placeholder="Text to push to device clipboard..."
                      value={clipboardText}
                      onChange={(e) => setClipboardText(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleSetClipboard}
                      disabled={!clipboardText || !selectedDeviceId}
                    >
                      <Clipboard size={12} />
                      <span>Set Clipboard</span>
                    </button>
                  </div>
                </div></div>
              <div className="screen-side-stack">
              <div className="workspace-panel"><div className="flex flex-col gap-2">
                <label className="text-xs text-dim font-medium uppercase tracking-wider">
                  Stream & Codec Configuration
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-dim block mb-1">Codec</label>
                    <select
                      className="input text-xs w-full"
                      value={selectedCodec}
                      disabled={isMirrorActive}
                      onChange={(e) => setSelectedCodec(e.target.value as any)}
                    >
                      <option value="h264">H.264 (Default)</option>
                      <option value="h265">H.265 (HEVC)</option>
                      <option value="av1">AV1</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[10px] text-dim block mb-1">Max Resolution</label>
                    <select
                      className="input text-xs w-full"
                      value={maxSize}
                      disabled={isMirrorActive}
                      onChange={(e) => setMaxSize(Number(e.target.value))}
                    >
                      <option value={0}>Native / Best</option>
                      <option value={1920}>1080p</option>
                      <option value={1280}>720p</option>
                      <option value={800}>480p</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[10px] text-dim block mb-1">Max Frame Rate</label>
                    <select
                      className="input text-xs w-full"
                      value={maxFps}
                      disabled={isMirrorActive}
                      onChange={(e) => setMaxFps(Number(e.target.value))}
                    >
                      <option value={60}>60 FPS</option>
                      <option value={30}>30 FPS</option>
                      <option value={15}>15 FPS</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-4 mt-1">
                  <label className="widget-check">
                    <input
                      type="checkbox"
                      checked={stayAwake}
                      disabled={isMirrorActive}
                      onChange={(e) => setStayAwake(e.target.checked)}
                    />
                    <span>Stay Awake</span>
                  </label>

                  <label
                    className={`widget-check ${!isAudioAvailable ? 'opacity-60 cursor-not-allowed' : ''}`}
                    title={
                      !isAudioAvailable
                        ? 'Audio decoding is not supported in this browser environment'
                        : 'Stream Android device audio'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={audioEnabled && isAudioAvailable}
                      disabled={isMirrorActive || !isAudioAvailable}
                      onChange={(e) => setAudioEnabled(e.target.checked)}
                    />
                    <span>Forward Audio</span>
                    {!isAudioAvailable && (
                      <span className="badge badge-warning text-[10px] ml-1">Unsupported in browser</span>
                    )}
                  </label>
                </div>
              </div></div>
              <details className="workspace-panel widget-disclosure media-engine-note" aria-labelledby="media-engine-heading">
                <summary className="widget-summary" style={{ minHeight: '52px', padding: '12px 16px' }}>
                  <Eye size={16} className="text-emerald flex-shrink-0" />
                  <span className="widget-heading"><span id="media-engine-heading" className="panel-title">Real-time scrcpy 3.3.1 media engine</span></span>
                  <span className="badge badge-neutral">Standalone extension</span>
                </summary>
                <div className="widget-body" style={{ padding: '12px 16px', gap: '8px' }}>
                  <p className="text-xs text-dim leading-relaxed">
                    Interactive display mirroring uses official <code className="text-emerald font-mono">scrcpy-server 3.3.1</code> deployed
                    to the device and connected via an owned forward tunnel. Raw binary video and bidirectional control protocol
                    frames stream over WebSocket directly to WebCodecs and WebGL canvas decoders.
                  </p>
                  <p className="text-xs text-dim leading-relaxed">
                    Touch gestures, pointer dragging, hardware key events, clipboard synchronization,
                    and browser-side canvas recording operate natively.
                  </p>
                </div>
              </details>
              </div>
            </div></div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Media"
            coveragePrefix="V"
            title="Screen & Media Operations"
            description="Framebuffer captures, screenrecord encoding, touch coordinates, and clipboard synchronization"
          />
        </>
      }]} />
    </div>
  );
};
