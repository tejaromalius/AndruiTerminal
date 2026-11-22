import { DeviceMessageParser } from './deviceMessages.js';
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  ScrcpyControlMessageSerializer,
  type ScrcpyMediaStreamPacket,
  ScrcpyOptions3_3_1,
  ScrcpyVideoCodecId,
} from '@yume-chan/scrcpy';
import {
  BitmapVideoFrameRenderer,
  VideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs';
import { PushReadableStream, TransformStream, WritableStream } from '@yume-chan/stream-extra';
import { ScreenSessionResponse } from './types.js';

export interface ScrcpyClientEvents {
  onMetadata?: (meta: { deviceName?: string; codec?: string; width?: number; height?: number }) => void;
  onClipboard?: (text: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export class ScrcpyClient {
  private session: ScreenSessionResponse;
  private canvas: HTMLCanvasElement;
  private videoWs: WebSocket | null = null;
  private audioWs: WebSocket | null = null;
  private controlWs: WebSocket | null = null;
  private options: ScrcpyOptions3_3_1<true>;
  private serializer: ScrcpyControlMessageSerializer;
  private decoder: WebCodecsVideoDecoder | null = null;
  private renderer: VideoFrameRenderer | null = null;
  private audioDecoder: any = null;
  private audioContext: AudioContext | null = null;
  private audioDestinationNode: MediaStreamAudioDestinationNode | null = null;
  private audioNextStartTime = 0;
  private events: ScrcpyClientEvents;
  private disposed = false;
  private frameWatchdog: ReturnType<typeof setInterval> | null = null;
  private readonly deviceMessages = new DeviceMessageParser(text => this.events.onClipboard?.(text));

  public videoWidth = 0;
  public videoHeight = 0;
  public deviceName = '';

  constructor(
    session: ScreenSessionResponse,
    canvas: HTMLCanvasElement,
    events: ScrcpyClientEvents = {}
  ) {
    this.session = session;
    this.canvas = canvas;
    this.events = events;

    const codecStr = (session.capabilities.videoCodec || 'h264').toLowerCase();
    const codec =
      codecStr === 'h265'
        ? ('h265' as const)
        : codecStr === 'av1'
        ? ('av1' as const)
        : ('h264' as const);

    this.options = new ScrcpyOptions3_3_1({
      videoCodec: codec,
      audio: session.capabilities.audio,
      audioCodec: 'opus',
      tunnelForward: true,
      sendDummyByte: true,
      sendDeviceMeta: true,
      sendCodecMeta: true,
    });

    this.serializer = new ScrcpyControlMessageSerializer(this.options);
  }

  static isWebCodecsSupported(): boolean {
    return typeof WebCodecsVideoDecoder !== 'undefined' && WebCodecsVideoDecoder.isSupported;
  }

  static isAudioSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof (window as any).AudioDecoder !== 'undefined' &&
      typeof (window.AudioContext || (window as any).webkitAudioContext) !== 'undefined'
    );
  }

  get recordedAudioTrack(): MediaStreamTrack | undefined {
    return this.audioDestinationNode?.stream?.getAudioTracks()[0];
  }

  async start(): Promise<void> {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    // 1. Establish Control WebSocket
    const controlUrl = `${wsProto}//${host}${this.session.controlUrl}`;
    this.controlWs = new WebSocket(controlUrl);
    this.controlWs.binaryType = 'arraybuffer';

    this.controlWs.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        this.handleDeviceMessage(new Uint8Array(e.data));
      }
    };

    this.controlWs.onerror = (err) => {
      this.events.onError?.(new Error(`Control WebSocket error: ${err}`));
    };

    // 2. Establish Video WebSocket
    const videoUrl = `${wsProto}//${host}${this.session.videoUrl}`;
    this.videoWs = new WebSocket(videoUrl);
    this.videoWs.binaryType = 'arraybuffer';

    const pushStream = new PushReadableStream<Uint8Array>((controller) => {
      if (!this.videoWs) return;

      this.videoWs.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(e.data));
        }
      };

      this.videoWs.onclose = () => {
        try {
          controller.close();
        } catch {
          // Stream might be closed already
        }
        if (!this.disposed) {
          this.events.onClose?.();
        }
      };

      this.videoWs.onerror = (err) => {
        const error = new Error(`Video WebSocket error: ${err}`);
        try {
          controller.error(error);
        } catch {
          // ignore
        }
        this.events.onError?.(error);
      };
    });

    // 3. Setup video pipeline
    try {
      const { metadata, stream } = await this.options.parseVideoStreamMetadata(pushStream);
      this.videoWidth = metadata.width || 0;
      this.videoHeight = metadata.height || 0;
      this.deviceName = metadata.deviceName || '';

      if (this.videoWidth > 0 && this.videoHeight > 0) {
        this.canvas.width = this.videoWidth;
        this.canvas.height = this.videoHeight;
      }

      this.events.onMetadata?.({
        deviceName: this.deviceName,
        // metadata.codec is a numeric FourCC id; report its name.
        codec:
          metadata.codec === ScrcpyVideoCodecId.H265
            ? 'h265'
            : metadata.codec === ScrcpyVideoCodecId.AV1
            ? 'av1'
            : 'h264',
        width: this.videoWidth,
        height: this.videoHeight,
      });

      // 4. Validate WebCodecs Video Decoder support
      if (!ScrcpyClient.isWebCodecsSupported()) {
        const err = new Error(
          'WebCodecs is not supported in this browser. Hardware video decoding is unavailable.'
        );
        this.events.onError?.(err);
        throw err;
      }

      // Check codec isConfigSupported if available
      const VideoDecoderClass = (window as any).VideoDecoder;
      const codecId =
        metadata.codec === ScrcpyVideoCodecId.H265
          ? ScrcpyVideoCodecId.H265
          : metadata.codec === ScrcpyVideoCodecId.AV1
          ? ScrcpyVideoCodecId.AV1
          : ScrcpyVideoCodecId.H264;

      if (VideoDecoderClass && typeof VideoDecoderClass.isConfigSupported === 'function') {
        const checkCodecStr =
          codecId === ScrcpyVideoCodecId.H265
            ? 'hev1.1.6.L93.B0'
            : codecId === ScrcpyVideoCodecId.AV1
            ? 'av01.0.04M.08'
            : 'avc1.42E01E';

        try {
          const support = await VideoDecoderClass.isConfigSupported({
            codec: checkCodecStr,
            codedWidth: this.videoWidth || 1920,
            codedHeight: this.videoHeight || 1080,
          });
          if (!support.supported) {
            const err = new Error(
              `Video codec '${this.session.capabilities.videoCodec}' is not supported by WebCodecs VideoDecoder`
            );
            this.events.onError?.(err);
            throw err;
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('not supported')) {
            this.events.onError?.(e);
            throw e;
          }
        }
      }

      // Initialize Renderer: WebGL first, fallback to 2D Bitmap canvas; explicit error if both fail
      try {
        this.renderer = new WebGLVideoFrameRenderer(this.canvas, true);
      } catch (webglErr) {
        try {
          this.renderer = new BitmapVideoFrameRenderer(this.canvas);
        } catch (bitmapErr) {
          const err = new Error(
            `Video renderers failed to initialize: WebGL (${webglErr}) and Bitmap 2D (${bitmapErr})`
          );
          this.events.onError?.(err);
          throw err;
        }
      }

      this.decoder = new WebCodecsVideoDecoder({
        codec: codecId,
        renderer: this.renderer,
      });

      this.decoder.sizeChanged((size) => {
        this.videoWidth = size.width;
        this.videoHeight = size.height;
        this.canvas.width = size.width;
        this.canvas.height = size.height;
      });

      const transformer = this.options.createMediaStreamTransformer();
      let videoPackets = 0;
      const packetCounter = new TransformStream<ScrcpyMediaStreamPacket, ScrcpyMediaStreamPacket>({
        transform(packet, controller) {
          if (packet.type === 'data') videoPackets += 1;
          controller.enqueue(packet);
        },
      });
      this.startFrameWatchdog(() => videoPackets);
      stream.pipeThrough(transformer).pipeThrough(packetCounter).pipeTo(this.decoder.writable).catch((err) => {
        if (!this.disposed) {
          this.events.onError?.(new Error(`Decoder stream error: ${err}`));
        }
      });
    } catch (err: unknown) {
      if (!this.disposed) {
        this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 5. Establish Audio WebSocket & AudioDecoder pipeline if requested
    if (this.session.audioUrl && this.session.capabilities.audio) {
      await this.startAudioStream(wsProto, host);
    }
  }

  private async startAudioStream(wsProto: string, host: string): Promise<void> {
    if (!ScrcpyClient.isAudioSupported()) {
      const err = new Error(
        'Audio decoding is not supported in this browser environment (AudioDecoder/AudioContext missing)'
      );
      this.events.onError?.(err);
      return;
    }

    const AudioDecoderClass = (window as any).AudioDecoder;
    if (AudioDecoderClass && typeof AudioDecoderClass.isConfigSupported === 'function') {
      try {
        const support = await AudioDecoderClass.isConfigSupported({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        });
        if (!support.supported) {
          const err = new Error(
            "Opus audio codec is not supported by this browser's WebCodecs AudioDecoder"
          );
          this.events.onError?.(err);
          return;
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('not supported')) {
          this.events.onError?.(e);
          return;
        }
      }
    }

    const audioUrl = `${wsProto}//${host}${this.session.audioUrl}`;
    this.audioWs = new WebSocket(audioUrl);
    this.audioWs.binaryType = 'arraybuffer';

    const audioPushStream = new PushReadableStream<Uint8Array>((controller) => {
      if (!this.audioWs) return;

      this.audioWs.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          controller.enqueue(new Uint8Array(e.data));
        }
      };

      this.audioWs.onclose = () => {
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      this.audioWs.onerror = (err) => {
        const error = new Error(`Audio WebSocket error: ${err}`);
        try {
          controller.error(error);
        } catch {
          // ignore
        }
        this.events.onError?.(error);
      };
    });

    try {
      const audioMeta = await this.options.parseAudioStreamMetadata(audioPushStream);
      if (audioMeta.type === 'disabled') {
        return;
      }
      if (audioMeta.type === 'errored') {
        this.events.onError?.(
          new Error(
            'Device audio capture failed or is unsupported on target Android device (requires Android 11+)'
          )
        );
        return;
      }

      if (audioMeta.type === 'success') {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        this.audioContext = new AudioCtx({ sampleRate: 48000 });
        this.audioDestinationNode = this.audioContext.createMediaStreamDestination();

        const EncodedAudioChunkClass = (window as any).EncodedAudioChunk;
        this.audioDecoder = new AudioDecoderClass({
          output: (audioData: any) => {
            if (!this.audioContext || !this.audioDestinationNode || this.disposed) {
              audioData?.close?.();
              return;
            }
            try {
              const numberOfChannels = audioData.numberOfChannels || 2;
              const numberOfFrames = audioData.numberOfFrames || 960;
              const sampleRate = audioData.sampleRate || 48000;
              const buffer = this.audioContext.createBuffer(
                numberOfChannels,
                numberOfFrames,
                sampleRate
              );

              for (let ch = 0; ch < numberOfChannels; ch++) {
                if (typeof audioData.copyTo === 'function') {
                  audioData.copyTo(buffer.getChannelData(ch), { planeIndex: ch });
                }
              }

              const source = this.audioContext.createBufferSource();
              source.buffer = buffer;
              source.connect(this.audioContext.destination);
              source.connect(this.audioDestinationNode);

              const now = this.audioContext.currentTime;
              const startTime = Math.max(now, this.audioNextStartTime);
              source.start(startTime);
              this.audioNextStartTime = startTime + buffer.duration;
            } catch (playErr) {
              console.warn('Audio frame playback error:', playErr);
            } finally {
              audioData?.close?.();
            }
          },
          error: (err: any) => {
            if (!this.disposed) {
              this.events.onError?.(new Error(`AudioDecoder error: ${err?.message || err}`));
            }
          },
        });

        this.audioDecoder.configure({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
        });

        const audioTransformer = this.options.createMediaStreamTransformer();
        audioMeta.stream
          .pipeThrough(audioTransformer)
          .pipeTo(
            new WritableStream({
              write: (packet) => {
                if (
                  !this.audioDecoder ||
                  this.disposed ||
                  this.audioDecoder.state !== 'configured'
                ) {
                  return;
                }
                if (packet.type === 'data') {
                  try {
                    const chunk = new EncodedAudioChunkClass({
                      type: packet.keyframe ? 'key' : 'delta',
                      timestamp: Number(packet.pts ?? 0n),
                      data: packet.data,
                    });
                    this.audioDecoder.decode(chunk);
                  } catch {
                    // ignore individual packet decode errors
                  }
                }
              },
            })
          )
          .catch((err) => {
            if (!this.disposed) {
              this.events.onError?.(new Error(`Audio stream error: ${err}`));
            }
          });
      }
    } catch (err: unknown) {
      if (!this.disposed) {
        this.events.onError?.(
          err instanceof Error ? err : new Error(`Failed to parse audio stream: ${err}`)
        );
      }
    }
  }

  private handleDeviceMessage(data: Uint8Array): void {
    try { this.deviceMessages.push(data); }
    catch (error) { this.events.onError?.(error instanceof Error ? error : new Error(String(error))); }
  }

  private sendControl(bytes: Uint8Array | [Uint8Array, Promise<void>] | undefined): void {
    if (!bytes || !this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = Array.isArray(bytes) ? bytes[0] : bytes;
    this.controlWs.send(payload);
  }

  // Pointer / Touch Injection
  injectTouch(
    action: AndroidMotionEventAction,
    pointerX: number,
    pointerY: number,
    pressure = 1.0,
    buttons = AndroidMotionEventButton.Primary
  ): void {
    const msg = this.serializer.injectTouch({
      action,
      pointerId: -1n,
      pointerX,
      pointerY,
      videoWidth: this.videoWidth || this.canvas.width || 1080,
      videoHeight: this.videoHeight || this.canvas.height || 1920,
      pressure,
      buttons,
      actionButton:
        action === AndroidMotionEventAction.Down
          ? AndroidMotionEventButton.Primary
          : AndroidMotionEventButton.None,
    });
    this.sendControl(msg);
  }

  // Scroll Injection
  injectScroll(pointerX: number, pointerY: number, scrollX: number, scrollY: number): void {
    const msg = this.serializer.injectScroll({
      pointerX,
      pointerY,
      videoWidth: this.videoWidth || this.canvas.width || 1080,
      videoHeight: this.videoHeight || this.canvas.height || 1920,
      scrollX,
      scrollY,
      buttons: 0,
    });
    this.sendControl(msg);
  }

  // Keycode Injection
  injectKeyCode(keyCode: number): void {
    const down = this.serializer.injectKeyCode({
      action: AndroidKeyEventAction.Down,
      keyCode: keyCode as AndroidKeyCode,
      repeat: 0,
      metaState: 0,
    });
    const up = this.serializer.injectKeyCode({
      action: AndroidKeyEventAction.Up,
      keyCode: keyCode as AndroidKeyCode,
      repeat: 0,
      metaState: 0,
    });
    this.sendControl(down);
    this.sendControl(up);
  }

  // Text Injection
  injectText(text: string): void {
    const msg = this.serializer.injectText(text);
    this.sendControl(msg);
  }

  // Set Clipboard
  setClipboard(text: string, paste = false): void {
    const msg = this.serializer.setClipboard({
      sequence: 0n,
      paste,
      content: text,
    });
    this.sendControl(msg);
  }

  // Screen Power Mode (0 = Off, 2 = On)
  setDisplayPower(mode: 0 | 2): void {
    const msg = this.serializer.setDisplayPower(mode);
    this.sendControl(msg);
  }

  // Navigation Keys Helper
  sendHome(): void {
    this.injectKeyCode(AndroidKeyCode.AndroidHome);
  }

  sendBack(): void {
    this.injectKeyCode(AndroidKeyCode.AndroidBack);
  }

  sendAppSwitch(): void {
    this.injectKeyCode(AndroidKeyCode.AndroidAppSwitch);
  }

  sendPower(): void {
    this.injectKeyCode(AndroidKeyCode.Power);
  }

  sendVolumeUp(): void {
    this.injectKeyCode(AndroidKeyCode.VolumeUp);
  }

  sendVolumeDown(): void {
    this.injectKeyCode(AndroidKeyCode.VolumeDown);
  }

  rotateDevice(): void {
    const msg = this.serializer.rotateDevice();
    this.sendControl(msg);
  }

  /**
   * Some browsers (notably Firefox with hardware decoding) accept the stream
   * without error but never output a frame. Report that instead of a blank canvas.
   */
  private startFrameWatchdog(packetCount: () => number): void {
    const timeoutMs = 5000;
    let waitedMs = 0;
    this.frameWatchdog = setInterval(() => {
      if (this.disposed || !this.decoder || this.decoder.framesRendered > 0) {
        this.stopFrameWatchdog();
        return;
      }
      // Hidden tabs do not render, so only count visible time after video has arrived.
      if (document.hidden || packetCount() === 0) return;
      waitedMs += 1000;
      if (waitedMs < timeoutMs) return;
      this.stopFrameWatchdog();
      const firefox = /firefox/i.test(navigator.userAgent);
      this.events.onError?.(new Error(
        `The browser received ${packetCount()} video packets but decoded no frames in ${timeoutMs / 1000} s. ` +
        (firefox
          ? 'Firefox video decoding failed; this is usually hardware decoding. Set media.hardware-video-decoding.enabled to false in about:config and restart Firefox, or use a Chromium-based browser.'
          : 'The video decoder is not producing output; try disabling hardware video decoding in this browser.')
      ));
    }, 1000);
  }

  private stopFrameWatchdog(): void {
    if (this.frameWatchdog !== null) {
      clearInterval(this.frameWatchdog);
      this.frameWatchdog = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopFrameWatchdog();
    if (this.videoWs) {
      this.videoWs.close();
      this.videoWs = null;
    }
    if (this.audioWs) {
      this.audioWs.close();
      this.audioWs = null;
    }
    if (this.controlWs) {
      this.controlWs.close();
      this.controlWs = null;
    }
    if (this.decoder) {
      this.decoder.dispose();
      this.decoder = null;
    }
    if (this.audioDecoder) {
      try {
        this.audioDecoder.close();
      } catch {}
      this.audioDecoder = null;
    }
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }
    this.audioDestinationNode = null;
  }
}
