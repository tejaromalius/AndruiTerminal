export interface MediaCapabilities {
  adbAvailable: boolean;
  adbVersion?: string;
  scrcpyServer: {
    available: boolean;
    version: string;
    path?: string;
  };
  supportedVideoCodecs: ('h264' | 'h265' | 'av1')[];
  supportedAudioCodecs: ('opus' | 'aac' | 'raw')[];
  maxFpsDefault: number;
  defaultVideoBitrate: number;
}

export interface CreateSessionOptions {
  deviceId: string;
  videoCodec?: 'h264' | 'h265' | 'av1';
  audio?: boolean;
  maxSize?: number;
  bitRate?: number;
  maxFps?: number;
  displayId?: number;
  stayAwake?: boolean;
}

export interface ScreenSessionResponse {
  id: string;
  videoUrl: string;
  audioUrl?: string;
  controlUrl: string;
  capabilities: {
    videoCodec: string;
    audio: boolean;
    maxSize: number;
    bitRate: number;
    maxFps: number;
    displayId: number;
  };
}

export interface CaptureResponse {
  dataUrl: string;
}

export interface CoordinateMapping {
  x: number;
  y: number;
}
