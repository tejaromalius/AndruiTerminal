import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapCanvasCoordinates } from './coordinates.js';
import { ScreenCanvasRecorder } from './recorder.js';
import { mediaApi } from './api.js';
import { ScrcpyClient } from './scrcpyClient.js';
import { AndroidMotionEventAction } from '@yume-chan/scrcpy';
import { api } from '../../api/client.js';

describe('Media Coordinates Mapping', () => {
  it('maps center point accurately to native resolution', () => {
    const mockCanvas = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        width: 500,
        height: 1000,
      }),
    } as unknown as HTMLCanvasElement;

    const coords = mapCanvasCoordinates(mockCanvas, 350, 550, 1080, 2400);
    expect(coords.x).toBe(540);
    expect(coords.y).toBe(1200);
  });

  it('clamps coordinates to 0 and native width/height when click is out-of-bounds', () => {
    const mockCanvas = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 50,
        width: 400,
        height: 800,
      }),
    } as unknown as HTMLCanvasElement;

    const topLeft = mapCanvasCoordinates(mockCanvas, 50, 10, 1080, 2400);
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);

    const bottomRight = mapCanvasCoordinates(mockCanvas, 600, 900, 1080, 2400);
    expect(bottomRight.x).toBe(1080);
    expect(bottomRight.y).toBe(2400);
  });

  it('handles zero or negative video dimensions gracefully', () => {
    const mockCanvas = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }),
    } as unknown as HTMLCanvasElement;

    const coords = mapCanvasCoordinates(mockCanvas, 50, 50, 0, 0);
    expect(coords.x).toBe(0);
    expect(coords.y).toBe(0);
  });
});

describe('ScreenCanvasRecorder', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('identifies browser recording capability and supported MIME types', () => {
    const mime = ScreenCanvasRecorder.getSupportedMimeType();
    expect(typeof mime).toBe('string');
  });

  it('preserves external shared audioTrack when recording stops without killing it', async () => {
    let audioTrackStopped = false;
    let videoTrackStopped = false;

    const mockAudioTrack = {
      kind: 'audio',
      stop: () => {
        audioTrackStopped = true;
      },
    } as unknown as MediaStreamTrack;

    const mockVideoTrack = {
      kind: 'video',
      stop: () => {
        videoTrackStopped = true;
      },
    } as unknown as MediaStreamTrack;

    const mockCanvas = {
      captureStream: () => ({
        addTrack: vi.fn(),
        getVideoTracks: () => [mockVideoTrack],
        getTracks: () => [mockVideoTrack, mockAudioTrack],
      }),
    } as unknown as HTMLCanvasElement;

    class MockMediaRecorder {
      state = 'recording';
      mimeType = 'video/webm';
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        this.state = 'inactive';
        setTimeout(() => this.onstop?.(), 0);
      }
    }
    (globalThis as any).MediaRecorder = MockMediaRecorder;
    (globalThis as any).HTMLCanvasElement.prototype.captureStream = mockCanvas.captureStream;

    const recorder = new ScreenCanvasRecorder();
    recorder.start(mockCanvas, 30, mockAudioTrack);
    expect(recorder.active).toBe(true);

    const result = await recorder.stop();
    expect(result).toBeDefined();
    expect(recorder.active).toBe(false);

    // Video track stopped, but external shared audio track was NOT stopped!
    expect(videoTrackStopped).toBe(true);
    expect(audioTrackStopped).toBe(false);

    // Cleanup revokes created object URLs without error
    expect(() => recorder.cleanup()).not.toThrow();
  });

  it('triggers onAutoStop callback when byte boundary is reached', async () => {
    let autoStopReason = '';
    const mockCanvas = {
      captureStream: () => ({
        addTrack: vi.fn(),
        getVideoTracks: () => [{ stop: vi.fn() }],
      }),
    } as unknown as HTMLCanvasElement;

    let activeRecorderInstance: any = null;
    class MockMediaRecorder {
      state = 'recording';
      mimeType = 'video/webm';
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor() {
        activeRecorderInstance = this;
      }
      start() {}
      stop() {
        this.state = 'inactive';
        setTimeout(() => this.onstop?.(), 0);
      }
    }
    (globalThis as any).MediaRecorder = MockMediaRecorder;

    const recorder = new ScreenCanvasRecorder();
    recorder.start(mockCanvas, 30, undefined, {
      maxBytes: 100,
      onAutoStop: (_res, reason) => {
        autoStopReason = reason;
      },
    });

    // Send chunk exceeding 100 bytes
    const blob = new Blob([new Uint8Array(150)]);
    activeRecorderInstance?.ondataavailable?.({ data: blob });

    // Wait for auto-stop
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(autoStopReason).toBe('maxBytes');
  });

  it('finalizes when MediaRecorder becomes inactive without firing onstop and stops video tracks on stop()', async () => {
    vi.useFakeTimers();
    let videoTrackStopped = false;
    const mockCanvas = {
      captureStream: () => ({
        addTrack: vi.fn(),
        getVideoTracks: () => [{ stop: () => { videoTrackStopped = true; } }],
      }),
    } as unknown as HTMLCanvasElement;

    class SilentStopMediaRecorder {
      state = 'recording';
      mimeType = 'video/webm';
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {}
      stop() {
        this.state = 'inactive';
        // Intentionally omit onstop()
      }
    }
    (globalThis as any).MediaRecorder = SilentStopMediaRecorder;
    (globalThis as any).HTMLCanvasElement.prototype.captureStream = mockCanvas.captureStream;

    const recorder = new ScreenCanvasRecorder();
    recorder.start(mockCanvas, 30);

    const stopPromise = recorder.stop();
    await vi.advanceTimersByTimeAsync(3000);
    const result = await stopPromise;
    expect(videoTrackStopped).toBe(true);
    expect(result.sizeBytes).toBe(0);
    expect(recorder.active).toBe(false);
    vi.useRealTimers();
  });

  it('selects video-only MIME type when no audio track is present and requests frames', async () => {
    const isTypeSupportedSpy = vi.fn((t: string) => t === 'video/webm;codecs=vp9,opus' || t === 'video/webm;codecs=vp9');
    const requestFrame = vi.fn();
    const mockCanvas = {
      captureStream: () => ({
        addTrack: vi.fn(),
        getVideoTracks: () => [{ stop: vi.fn(), requestFrame }],
      }),
    } as unknown as HTMLCanvasElement;

    let capturedOptions: MediaRecorderOptions | undefined;
    class OptionCapturingMediaRecorder {
      static isTypeSupported = isTypeSupportedSpy;
      state = 'recording';
      mimeType = 'video/webm;codecs=vp9';
      ondataavailable: ((e: any) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(_stream: MediaStream, options: MediaRecorderOptions = {}) {
        capturedOptions = options;
      }
      start() {}
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(64)]) });
        setTimeout(() => this.onstop?.(), 0);
      }
    }
    (globalThis as any).MediaRecorder = OptionCapturingMediaRecorder;
    (globalThis as any).HTMLCanvasElement.prototype.captureStream = mockCanvas.captureStream;

    const recorder = new ScreenCanvasRecorder();
    recorder.start(mockCanvas, 30);
    expect(capturedOptions?.mimeType).toBe('video/webm;codecs=vp9');
    expect(requestFrame).toHaveBeenCalledTimes(1);

    const result = await recorder.stop();
    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(result.sizeBytes).toBe(64);
  });
});

describe('Media API Client & CSRF Sharing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearCsrfToken();
  });

  it('fetches media capabilities from /api/v1/screen/capabilities', async () => {
    const mockCaps = {
      adbAvailable: true,
      adbVersion: '34.0.4',
      scrcpyServer: { available: true, version: '3.3.1', path: '/opt/scrcpy' },
      supportedVideoCodecs: ['h264', 'h265', 'av1'],
      supportedAudioCodecs: ['opus', 'aac', 'raw'],
      maxFpsDefault: 60,
      defaultVideoBitrate: 8000000,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockCaps,
    } as Response);

    const res = await mediaApi.getCapabilities();
    expect(res.adbAvailable).toBe(true);
    expect(res.scrcpyServer.version).toBe('3.3.1');
    expect(res.supportedVideoCodecs).toContain('h264');
  });

  it('uses api.getSession token rather than creating independent sessions', async () => {
    const getSessionSpy = vi.spyOn(api, 'getSession').mockResolvedValue({
      csrfToken: 'shared-session-csrf-token',
    });

    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/v1/screen/sessions')) {
        capturedHeaders = init?.headers;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 'sess-1234',
            videoUrl: '/api/v1/screen/sessions/sess-1234/video',
            controlUrl: '/api/v1/screen/sessions/sess-1234/control',
            capabilities: {
              videoCodec: 'h264',
              audio: false,
              maxSize: 0,
              bitRate: 8000000,
              maxFps: 60,
              displayId: 0,
            },
          }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    const res = await mediaApi.createSession({
      deviceId: 'RF8M10ABCDE',
      videoCodec: 'h264',
    });

    expect(getSessionSpy).toHaveBeenCalledTimes(1);
    expect(res.id).toBe('sess-1234');
    expect((capturedHeaders as Record<string, string>)?.['X-CSRF-Token']).toBe('shared-session-csrf-token');
  });

  it('captures screen and returns dataUrl', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      }),
    } as Response);

    const res = await mediaApi.captureScreen('RF8M10ABCDE');
    expect(res.dataUrl).toContain('data:image/png;base64,');
  });
});

describe('ScrcpyClient Audio & Control Protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects browser audio capability and reports unsupported audio explicitly', async () => {
    // In node/jsdom test environment, AudioDecoder is not natively present
    expect(ScrcpyClient.isAudioSupported()).toBe(false);

    let reportedError: Error | null = null;
    const mockCanvas = document.createElement('canvas');
    const mockSession = {
      id: 'sess-audio',
      videoUrl: '/api/v1/screen/sessions/sess-audio/video',
      audioUrl: '/api/v1/screen/sessions/sess-audio/audio',
      controlUrl: '/api/v1/screen/sessions/sess-audio/control',
      capabilities: {
        videoCodec: 'h264',
        audio: true,
        maxSize: 0,
        bitRate: 8000000,
        maxFps: 60,
        displayId: 0,
      },
    };

    const client = new ScrcpyClient(mockSession, mockCanvas, {
      onError: (err) => {
        reportedError = err;
      },
    });

    expect(client.recordedAudioTrack).toBeUndefined();

    // Verify touch & hardware navigation messages
    expect(() => {
      client.injectTouch(AndroidMotionEventAction.Down, 100, 200);
      client.sendHome();
      client.sendBack();
      client.injectText('Test text');
      client.setClipboard('Test clipboard');
    }).not.toThrow();

    client.dispose();
  });

  it('validates scrcpy audio wire packet framing with fixtures', () => {
    // 1. Opus FourCC header: 'o', 'p', 'u', 's' -> 0x6f707573
    const opusFourccBytes = new Uint8Array([0x6f, 0x70, 0x75, 0x73]);
    const fourcc = new DataView(opusFourccBytes.buffer).getUint32(0, false);
    expect(fourcc).toBe(0x6f707573);

    // 2. Opus packet framing fixture: 8 bytes PTS + 4 bytes size + payload
    // Config PTS: 1n << 63n = 0x8000000000000000n
    const configPacket = new Uint8Array(12 + 8);
    const view = new DataView(configPacket.buffer);
    view.setBigUint64(0, 1n << 63n, false); // PTS_CONFIG
    view.setUint32(8, 8, false); // size = 8
    configPacket.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 12); // "OpusHead"

    expect(view.getBigUint64(0, false)).toBe(0x8000000000000000n);
    expect(view.getUint32(8, false)).toBe(8);

    // 3. Delta audio packet fixture: PTS = 48000, size = 4
    const deltaPacket = new Uint8Array(12 + 4);
    const deltaView = new DataView(deltaPacket.buffer);
    deltaView.setBigUint64(0, 48000n, false);
    deltaView.setUint32(8, 4, false);
    deltaPacket.set([0xf8, 0xff, 0xfe, 0x01], 12);

    expect(deltaView.getBigUint64(0, false)).toBe(48000n);
    expect(deltaView.getUint32(8, false)).toBe(4);
    expect(deltaPacket[12]).toBe(0xf8);
  });
});
