export interface RecordingResult {
  blob: Blob;
  url: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
}

export interface ScreenCanvasRecorderOptions {
  maxBytes?: number; // default: 250MB
  maxDurationMs?: number; // default: 5 minutes (300,000ms)
  onAutoStop?: (result: RecordingResult, reason: 'maxBytes' | 'maxDuration') => void;
  onError?: (err: Error) => void;
}

export class ScreenCanvasRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private sharedAudioTrack: MediaStreamTrack | null = null;
  private isRecording = false;
  private totalBytes = 0;
  private durationTimeout: ReturnType<typeof setTimeout> | null = null;
  private options: ScreenCanvasRecorderOptions = {};
  private createdUrls: string[] = [];

  static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof (HTMLCanvasElement.prototype as any).captureStream === 'function' &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  static getSupportedMimeType(): string {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
      return 'video/webm';
    }

    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return '';
  }

  get active(): boolean {
    return this.isRecording;
  }

  start(
    canvas: HTMLCanvasElement,
    fps = 30,
    audioTrack?: MediaStreamTrack,
    options: ScreenCanvasRecorderOptions = {}
  ): void {
    if (!ScreenCanvasRecorder.isSupported()) {
      throw new Error('Canvas recording is not supported in this browser environment');
    }

    this.options = options;
    this.recordedChunks = [];
    this.totalBytes = 0;
    this.sharedAudioTrack = audioTrack || null;

    const captureStream = (canvas as any).captureStream?.bind(canvas);
    if (!captureStream) {
      throw new Error('Canvas captureStream API is not available');
    }

    this.stream = captureStream(fps);
    if (audioTrack && this.stream) {
      this.stream.addTrack(audioTrack);
    }

    const mimeType = ScreenCanvasRecorder.getSupportedMimeType();
    const recorderOptions: MediaRecorderOptions = mimeType ? { mimeType } : {};

    try {
      this.mediaRecorder = new MediaRecorder(this.stream!, recorderOptions);
    } catch {
      this.mediaRecorder = new MediaRecorder(this.stream!);
    }

    const maxBytesLimit = options.maxBytes ?? 250 * 1024 * 1024; // 250MB bound

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.recordedChunks.push(event.data);
        this.totalBytes += event.data.size;

        if (this.totalBytes >= maxBytesLimit && this.isRecording) {
          setTimeout(async () => {
            try {
              const res = await this.stop();
              this.options.onAutoStop?.(res, 'maxBytes');
            } catch (err: unknown) {
              this.options.onError?.(
                err instanceof Error ? err : new Error(String(err))
              );
            }
          }, 0);
        }
      }
    };

    this.mediaRecorder.onerror = (event: Event) => {
      const err = new Error(`MediaRecorder error: ${(event as any).error || 'unknown'}`);
      this.options.onError?.(err);
    };

    this.mediaRecorder.start(1000); // 1s slice
    this.isRecording = true;

    // Bound recording time (default 5 minutes)
    const maxDurationMs = options.maxDurationMs ?? 300_000;
    this.durationTimeout = setTimeout(async () => {
      if (this.isRecording) {
        try {
          const res = await this.stop();
          this.options.onAutoStop?.(res, 'maxDuration');
        } catch (err: unknown) {
          this.options.onError?.(
            err instanceof Error ? err : new Error(String(err))
          );
        }
      }
    }, maxDurationMs);
  }

  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || !this.isRecording) {
        return reject(new Error('Recorder is not active'));
      }

      if (this.durationTimeout) {
        clearTimeout(this.durationTimeout);
        this.durationTimeout = null;
      }

      const recorder = this.mediaRecorder;
      let settled = false;
      let stopFallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const finalize = () => {
        if (settled) return;
        settled = true;
        if (stopFallbackTimer) {
          clearTimeout(stopFallbackTimer);
          stopFallbackTimer = null;
        }
        this.isRecording = false;
        const mimeType = recorder.mimeType || 'video/webm';
        const blob = new Blob(this.recordedChunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        this.createdUrls.push(url);

        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screen-recording-${timestamp}.${ext}`;

        // Stop only canvas video tracks; do NOT kill shared audio track
        if (this.stream) {
          this.stream.getVideoTracks().forEach((track) => track.stop());
          this.stream = null;
        }

        resolve({
          blob,
          url,
          mimeType,
          filename,
          sizeBytes: blob.size,
        });
      };

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (stopFallbackTimer) {
          clearTimeout(stopFallbackTimer);
          stopFallbackTimer = null;
        }
        this.isRecording = false;
        if (this.stream) {
          this.stream.getVideoTracks().forEach((track) => track.stop());
          this.stream = null;
        }
        reject(err);
      };

      if (recorder.state === 'inactive') {
        if (this.recordedChunks.length > 0) {
          finalize();
        } else {
          fail(new Error('MediaRecorder stopped before capturing any data'));
        }
        return;
      }

      recorder.onstop = finalize;
      recorder.onerror = (event: Event) => {
        fail(new Error(`MediaRecorder error: ${(event as any).error || 'unknown'}`));
      };

      stopFallbackTimer = setTimeout(() => {
        if (this.recordedChunks.length > 0) {
          finalize();
        } else {
          fail(new Error('Timed out waiting for MediaRecorder to stop'));
        }
      }, 3000);

      try {
        if (recorder.state === 'recording' && typeof recorder.requestData === 'function') {
          recorder.requestData();
        }
        recorder.stop();
      } catch (err) {
        if (this.recordedChunks.length > 0) {
          finalize();
        } else {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  download(result: RecordingResult): void {
    const a = document.createElement('a');
    a.href = result.url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  cleanup(): void {
    if (this.durationTimeout) {
      clearTimeout(this.durationTimeout);
      this.durationTimeout = null;
    }

    if (this.isRecording && this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {}
      this.isRecording = false;
    }

    if (this.stream) {
      this.stream.getVideoTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    for (const url of this.createdUrls) {
      if (typeof URL.revokeObjectURL === 'function') {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }
    }
    this.createdUrls = [];
  }
}
