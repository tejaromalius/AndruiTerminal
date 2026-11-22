import { describe, expect, it, vi } from 'vitest';
import { DeviceMessageParser } from './deviceMessages.js';
const message = (text: string) => {
  const body = new TextEncoder().encode(text);
  const bytes = new Uint8Array(body.length + 5);
  new DataView(bytes.buffer).setUint32(1, body.length, false);
  bytes.set(body, 5); return bytes;
};
describe('scrcpy device control framing', () => {
  it('preserves fragmented unicode and multiple messages with acknowledgements', () => {
    const clipboard = vi.fn(); const parser = new DeviceMessageParser(clipboard);
    const first = message('Android ✓'); const second = message('second');
    const bytes = new Uint8Array(first.length + 9 + second.length);
    bytes.set(first); bytes[first.length] = 1; bytes.set(second, first.length + 9);
    for (const byte of bytes) parser.push(new Uint8Array([byte]));
    expect(clipboard.mock.calls).toEqual([['Android ✓'], ['second']]);
  });
  it('rejects oversized and unknown messages', () => {
    expect(() => new DeviceMessageParser(vi.fn()).push(new Uint8Array([0,255,255,255,255]))).toThrow(/limit/);
    expect(() => new DeviceMessageParser(vi.fn()).push(new Uint8Array([99]))).toThrow(/Unknown/);
  });
});
