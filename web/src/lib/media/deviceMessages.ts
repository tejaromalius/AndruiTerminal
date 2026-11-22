/** Parse device control messages independently of TCP/WebSocket frame boundaries. */
export class DeviceMessageParser {
  private pending = new Uint8Array(0);
  constructor(private readonly onClipboard: (text: string) => void) {}

  push(chunk: Uint8Array): void {
    if (this.pending.length + chunk.length > 1024 * 1024) throw new Error('Device control buffer exceeded 1 MiB');
    const bytes = new Uint8Array(this.pending.length + chunk.length);
    bytes.set(this.pending); bytes.set(chunk, this.pending.length);
    let offset = 0;
    while (offset < bytes.length) {
      const available = bytes.length - offset;
      const type = bytes[offset];
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, available);
      let size: number;
      if (type === 0) {
        if (available < 5) break;
        const length = view.getUint32(1, false);
        if (length > 262139) throw new Error('Clipboard message exceeds scrcpy protocol limit');
        size = 5 + length;
      } else if (type === 1) {
        size = 9; // Clipboard sequence acknowledgement.
      } else if (type === 2) {
        if (available < 5) break;
        size = 5 + view.getUint16(3, false); // UHID output: id, size, data.
      } else throw new Error(`Unknown scrcpy device message type ${type}`);
      if (available < size) break;
      if (type === 0) this.onClipboard(new TextDecoder().decode(bytes.subarray(offset + 5, offset + size)));
      offset += size;
    }
    this.pending = bytes.slice(offset);
  }
}
