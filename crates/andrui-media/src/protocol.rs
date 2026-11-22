use bytes::{Buf, BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};

pub const SCRCPY_VERSION: &str = "3.3.1";
pub const DEVICE_NAME_FIELD_LENGTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VideoCodec {
    H264,
    H265,
    Av1,
}

impl VideoCodec {
    pub fn to_fourcc(&self) -> u32 {
        match self {
            VideoCodec::H264 => 0x68323634, // "h264"
            VideoCodec::H265 => 0x68323635, // "h265"
            VideoCodec::Av1 => 0x00617631,  // "av1"
        }
    }

    pub fn from_fourcc(fourcc: u32) -> Option<Self> {
        match fourcc {
            0x68323634 => Some(VideoCodec::H264),
            0x68323635 => Some(VideoCodec::H265),
            0x00617631 => Some(VideoCodec::Av1),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            VideoCodec::H264 => "h264",
            VideoCodec::H265 => "h265",
            VideoCodec::Av1 => "av1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioCodec {
    Opus,
    Aac,
    Raw,
}

impl AudioCodec {
    pub fn to_fourcc(&self) -> u32 {
        match self {
            AudioCodec::Opus => 0x6f707573, // "opus"
            AudioCodec::Aac => 0x00616163,  // "aac"
            AudioCodec::Raw => 0x00726177,  // "raw"
        }
    }

    pub fn from_fourcc(fourcc: u32) -> Option<Self> {
        match fourcc {
            0x6f707573 => Some(AudioCodec::Opus),
            0x00616163 | 0x61616320 => Some(AudioCodec::Aac),
            0x00726177 | 0x72617720 => Some(AudioCodec::Raw),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AudioCodec::Opus => "opus",
            AudioCodec::Aac => "aac",
            AudioCodec::Raw => "raw",
        }
    }
}

pub const PTS_CONFIG: u64 = 1 << 63;
pub const PTS_KEYFRAME: u64 = 1 << 62;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioStreamMetadata {
    Disabled,
    Errored,
    Success(AudioCodec),
}

/// Parses the 4-byte audio stream metadata header from scrcpy
pub fn parse_audio_metadata(buf: &mut BytesMut) -> Option<AudioStreamMetadata> {
    if buf.len() < 4 {
        return None;
    }
    let fourcc = buf.get_u32();
    match fourcc {
        0x00000000 => Some(AudioStreamMetadata::Disabled),
        0x00000001 => Some(AudioStreamMetadata::Errored),
        code => AudioCodec::from_fourcc(code).map(AudioStreamMetadata::Success),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioPacket {
    pub pts: u64,
    pub is_config: bool,
    pub is_keyframe: bool,
    pub data: Bytes,
}

/// Parses framed audio packet (8 bytes PTS, 4 bytes length, followed by payload)
pub fn parse_audio_packet(buf: &mut BytesMut) -> Option<AudioPacket> {
    if buf.len() < 12 {
        return None;
    }
    let raw_pts = u64::from_be_bytes(buf[..8].try_into().unwrap());
    let size = u32::from_be_bytes(buf[8..12].try_into().unwrap()) as usize;
    if buf.len() < 12 + size {
        return None;
    }

    buf.advance(12);
    let data = buf.split_to(size).freeze();

    let is_config = raw_pts == PTS_CONFIG;
    let is_keyframe = (raw_pts & PTS_KEYFRAME) != 0;
    let pts = if is_config {
        0
    } else if is_keyframe {
        raw_pts & !PTS_KEYFRAME
    } else {
        raw_pts
    };

    Some(AudioPacket {
        pts,
        is_config,
        is_keyframe,
        data,
    })
}

/// Serializes audio packet into scrcpy wire framing (8 bytes PTS, 4 bytes length, payload)
pub fn serialize_audio_packet(pts: u64, is_config: bool, is_keyframe: bool, data: &[u8]) -> Bytes {
    let mut buf = BytesMut::with_capacity(12 + data.len());
    let raw_pts = if is_config {
        PTS_CONFIG
    } else if is_keyframe {
        pts | PTS_KEYFRAME
    } else {
        pts
    };

    buf.put_u64(raw_pts);
    buf.put_u32(data.len() as u32);
    buf.put_slice(data);
    buf.freeze()
}

/// Control message types defined in scrcpy protocol
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlMessageType {
    InjectKeyCode = 0,
    InjectText = 1,
    InjectTouch = 2,
    InjectScroll = 3,
    BackOrScreenOn = 4,
    ExpandNotificationPanel = 5,
    ExpandSettingPanel = 6,
    CollapseNotificationPanel = 7,
    GetClipboard = 8,
    SetClipboard = 9,
    SetDisplayPower = 10,
    RotateDevice = 11,
    UhidCreate = 12,
    UhidInput = 13,
    UhidDestroy = 14,
    StartApp = 15,
    ResetVideo = 16,
}

/// Device-to-client message types
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceMessageType {
    Clipboard = 0,
    AckClipboard = 1,
    UhidOutput = 2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoMetadata {
    pub device_name: String,
    pub codec: String,
    pub width: u32,
    pub height: u32,
}

/// Parses video metadata from the beginning of scrcpy video stream (after the dummy byte):
/// 64 bytes null-terminated device name, followed by 12 bytes (codec: u32, width: u32, height: u32).
pub fn parse_video_metadata(buf: &mut BytesMut) -> Option<VideoMetadata> {
    if buf.len() < DEVICE_NAME_FIELD_LENGTH + 12 {
        return None;
    }

    let name_slice = &buf[..DEVICE_NAME_FIELD_LENGTH];
    let end = name_slice
        .iter()
        .position(|&b| b == 0)
        .unwrap_or(DEVICE_NAME_FIELD_LENGTH);
    let device_name = String::from_utf8_lossy(&name_slice[..end]).to_string();

    buf.advance(DEVICE_NAME_FIELD_LENGTH);
    let codec_fourcc = buf.get_u32();
    let width = buf.get_u32();
    let height = buf.get_u32();

    let codec = match VideoCodec::from_fourcc(codec_fourcc) {
        Some(c) => c.as_str().to_string(),
        None => format!("unknown_0x{:08x}", codec_fourcc),
    };

    Some(VideoMetadata {
        device_name,
        codec,
        width,
        height,
    })
}

/// Serializes inject keycode control message
pub fn serialize_inject_keycode(action: u8, keycode: i32, repeat: i32, metastate: i32) -> Bytes {
    let mut buf = BytesMut::with_capacity(14);
    buf.put_u8(ControlMessageType::InjectKeyCode as u8);
    buf.put_u8(action);
    buf.put_i32(keycode);
    buf.put_i32(repeat);
    buf.put_i32(metastate);
    buf.freeze()
}

/// Serializes inject text control message
pub fn serialize_inject_text(text: &str) -> Bytes {
    let text_bytes = text.as_bytes();
    let mut buf = BytesMut::with_capacity(1 + 4 + text_bytes.len());
    buf.put_u8(ControlMessageType::InjectText as u8);
    buf.put_u32(text_bytes.len() as u32);
    buf.put_slice(text_bytes);
    buf.freeze()
}

/// Serializes inject touch control message (Scrcpy 2.x/3.x format)
#[allow(clippy::too_many_arguments)]
pub fn serialize_inject_touch(
    action: u8,
    pointer_id: u64,
    x: i32,
    y: i32,
    width: u16,
    height: u16,
    pressure: u16,
    action_button: u32,
    buttons: u32,
) -> Bytes {
    let mut buf = BytesMut::with_capacity(32);
    buf.put_u8(ControlMessageType::InjectTouch as u8);
    buf.put_u8(action);
    buf.put_u64(pointer_id);
    buf.put_i32(x);
    buf.put_i32(y);
    buf.put_u16(width);
    buf.put_u16(height);
    buf.put_u16(pressure);
    buf.put_u32(action_button);
    buf.put_u32(buttons);
    buf.freeze()
}

/// Serializes inject scroll control message
pub fn serialize_inject_scroll(
    x: i32,
    y: i32,
    width: u16,
    height: u16,
    hscroll: i32,
    vscroll: i32,
    buttons: u32,
) -> Bytes {
    let mut buf = BytesMut::with_capacity(25);
    buf.put_u8(ControlMessageType::InjectScroll as u8);
    buf.put_i32(x);
    buf.put_i32(y);
    buf.put_u16(width);
    buf.put_u16(height);
    buf.put_i32(hscroll);
    buf.put_i32(vscroll);
    buf.put_u32(buttons);
    buf.freeze()
}

/// Serializes set screen power mode message (mode: 0 = off, 2 = on)
pub fn serialize_set_display_power(mode: u8) -> Bytes {
    let mut buf = BytesMut::with_capacity(2);
    buf.put_u8(ControlMessageType::SetDisplayPower as u8);
    buf.put_u8(mode);
    buf.freeze()
}

/// Serializes set clipboard control message
pub fn serialize_set_clipboard(sequence: u64, paste: bool, text: &str) -> Bytes {
    let text_bytes = text.as_bytes();
    let mut buf = BytesMut::with_capacity(1 + 8 + 1 + 4 + text_bytes.len());
    buf.put_u8(ControlMessageType::SetClipboard as u8);
    buf.put_u64(sequence);
    buf.put_u8(if paste { 1 } else { 0 });
    buf.put_u32(text_bytes.len() as u32);
    buf.put_slice(text_bytes);
    buf.freeze()
}

/// Serializes back or screen on control message
pub fn serialize_back_or_screen_on(action: u8) -> Bytes {
    let mut buf = BytesMut::with_capacity(2);
    buf.put_u8(ControlMessageType::BackOrScreenOn as u8);
    buf.put_u8(action);
    buf.freeze()
}
