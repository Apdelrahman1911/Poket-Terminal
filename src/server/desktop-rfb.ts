// A deliberately small client-to-fixed-TigerVNC protocol gate. No framebuffer
// parsing, dynamic targets, files, native commands or retained input transcripts.
export const DESKTOP_LIMITS = Object.freeze({ clients: 2, width: 1280, height: 720,
  frame: 16 * 1024, pending: 24 * 1024, clipboard: 4096, encodings: 64,
  messagesPerSecond: 256, operationsPerSecond: 1024, inputPerSecond: 64 * 1024,
  upstreamWrite: 64 * 1024, readChunk: 64 * 1024, transport: 256 * 1024,
  outstanding: 512 * 1024, pauseAt: 256 * 1024, resumeAt: 128 * 1024,
  ackMs: 5000, handshakeMs: 8000, connectMs: 2000, inputMs: 2000,
  heartbeatMs: 10000, deadMs: 30000, terminateMs: 250 });

export class RfbInput {
  private pending = Buffer.alloc(0);
  private phase: 'version' | 'security' | 'shared' | 'normal' = 'version';
  private operations = 0;
  private rateAt = Date.now();
  get ready() { return this.phase === 'normal'; }
  get pendingBytes() { return this.pending.length; }
  clear() { this.pending = Buffer.alloc(0); }
  feed(data: Buffer, forward: (data: Buffer) => void) {
    if (this.pending.length + data.length > DESKTOP_LIMITS.pending) throw new Error('rfb_input_limit');
    let input: Buffer = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    this.pending = Buffer.alloc(0);
    while (input.length) {
      let size: number;
      if (this.phase === 'version') size = 12;
      else if (this.phase !== 'normal') size = 1;
      else {
        switch (input[0]) {
          case 0: size = 20; break; // SetPixelFormat
          case 2: // SetEncodings (no unbounded list)
            if (input.length < 4) return this.hold(input);
            if (input.readUInt16BE(2) > DESKTOP_LIMITS.encodings) throw new Error('rfb_encoding_limit');
            size = 4 + input.readUInt16BE(2) * 4; break;
          case 3: case 150: size = 10; break; // framebuffer request / continuous updates
          case 4: size = 8; break; // key
          case 5: size = input[1]! & 128 ? 7 : 6; break; // extended pointer mask is one extra byte
          case 6: // Only classic bounded Latin-1 clipboard. No compressed/extended payloads.
            if (input.length < 8) return this.hold(input);
            if (input.readUInt32BE(4) > DESKTOP_LIMITS.clipboard) throw new Error('rfb_clipboard_limit');
            size = 8 + input.readUInt32BE(4); break;
          case 248: // fence
            if (input.length < 9) return this.hold(input);
            if (input[8]! > 64) throw new Error('rfb_fence_limit');
            size = 9 + input[8]!; break;
          case 255: size = 12; break; // QEMU extended key event only
          case 251: throw new Error('rfb_resize_disabled');
          default: throw new Error('rfb_operation_rejected');
        }
      }
      if (input.length < size) return this.hold(input);
      const packet = input.subarray(0, size);
      if (Date.now() - this.rateAt >= 1000) { this.rateAt = Date.now(); this.operations = 0; }
      if (++this.operations > DESKTOP_LIMITS.operationsPerSecond) throw new Error('rfb_operation_rate');
      if (this.phase === 'version') {
        if (packet.toString('ascii') !== 'RFB 003.008\n') throw new Error('rfb_version_rejected');
        this.phase = 'security';
      } else if (this.phase === 'security') {
        if (packet[0] !== 1) throw new Error('rfb_security_rejected');
        this.phase = 'shared';
      } else if (this.phase === 'shared') {
        if (packet[0] !== 1) throw new Error('rfb_shared_required');
        this.phase = 'normal';
      } else {
        if (packet[0] === 0 && (packet[4] !== 32 || packet[5] !== 24 || packet[7] !== 1)) throw new Error('rfb_pixel_format_rejected');
        if (packet[0] === 3 || packet[0] === 150) {
          if (packet[1]! > 1 || packet.readUInt16BE(2) + packet.readUInt16BE(6) > DESKTOP_LIMITS.width || packet.readUInt16BE(4) + packet.readUInt16BE(8) > DESKTOP_LIMITS.height) throw new Error('rfb_geometry_rejected');
        }
        if (packet[0] === 5 && (packet.readUInt16BE(2) >= DESKTOP_LIMITS.width || packet.readUInt16BE(4) >= DESKTOP_LIMITS.height)) throw new Error('rfb_pointer_rejected');
        if (packet[0] === 255 && packet[1] !== 0) throw new Error('rfb_extension_rejected');
      }
      forward(packet);
      input = input.subarray(size);
    }
  }
  private hold(data: Buffer) {
    // Largest permitted incomplete packet is 4,103 bytes; copy rather than
    // retaining a large parent frame. Partial packets also have a time deadline.
    if (data.length > DESKTOP_LIMITS.clipboard + 8) throw new Error('rfb_partial_limit');
    this.pending = Buffer.from(data);
  }
}
