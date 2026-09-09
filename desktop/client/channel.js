// Bounded RFB channel with application ACKs. ACK means accepted by the bounded
// parser and no pending render image, not a replay/receipt guarantee for input.
export class BoundedChannel {
  onopen = null; onclose = null; onmessage = null; onerror = null;
  binaryType = 'arraybuffer';
  received = 0; acked = 0; peakOutstanding = 0; peakSend = 0;
  timer = null; stalledAt = 0; disposed = false;
  constructor(url, csrf, fatal, pending, WebSocketClass = WebSocket) {
    this.fatal = fatal; this.pending = pending;
    this.socket = new WebSocketClass(url, ['pocketdesktop.v1', `csrf.${csrf}`]);
    this.socket.binaryType = 'arraybuffer';
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.socket.onopen = event => this.onopen?.(event);
    this.socket.onerror = event => this.onerror?.(event);
    this.socket.onclose = event => {
      this.onclose?.(event); this.dispose(); this.resolveClosed();
    };
    this.socket.onmessage = event => {
      if (this.disposed) return;
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength > 64 * 1024 || this.received - this.acked + data.byteLength > 512 * 1024) return this.fail();
      this.received += data.byteLength;
      this.peakOutstanding = Math.max(this.peakOutstanding, this.received - this.acked);
      try { this.onmessage?.(event); } catch { return this.fail(); }
      this.scheduleAck();
    };
  }
  get readyState() { return this.socket.readyState; }
  get protocol() { return this.socket.protocol; }
  get bufferedAmount() { return this.socket.bufferedAmount; }
  send(data) {
    if (this.disposed || this.readyState !== 1) return;
    if (!ArrayBuffer.isView(data) || data.byteLength > 16 * 1024 || this.bufferedAmount + data.byteLength > 64 * 1024) return this.fail();
    this.socket.send(data);
    this.peakSend = Math.max(this.peakSend, this.bufferedAmount);
  }
  scheduleAck() {
    if (this.timer || this.disposed) return;
    if (!this.stalledAt) this.stalledAt = performance.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.readyState !== 1) return;
      if (performance.now() - this.stalledAt > 2000 || this.bufferedAmount + 96 > 64 * 1024) return this.fail();
      if (this.pending()) return this.scheduleAck();
      if (this.received > this.acked) {
        this.socket.send(JSON.stringify({ type: 'ack', bytes: this.received }));
        this.acked = this.received;
      }
      this.stalledAt = 0;
    }, 16);
  }
  fail() { if (!this.disposed) { const fatal = this.fatal; this.dispose(); fatal(); } }
  close() { this.dispose(); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer); this.timer = null;
    this.onmessage = this.onopen = this.onerror = this.onclose = null;
    this.pending = () => false;
    this.fatal = () => {};
    this.socket.onmessage = this.socket.onopen = this.socket.onerror = null;
    // Keep only the native close completion callback. A new view must await it;
    // browsers have no terminate API, so we never overlap a stuck retiring socket.
    this.socket.onclose = () => { this.socket.onclose = null; this.resolveClosed(); };
    if (this.socket.readyState < 2) this.socket.close();
    else if (this.socket.readyState === 3) { this.socket.onclose = null; this.resolveClosed(); }
  }
  stats() {
    return { socket: this.disposed ? 0 : 1, ackTimers: this.timer ? 1 : 0,
      outstandingBytes: this.received - this.acked, sendBytes: this.bufferedAmount,
      peakOutstandingBytes: this.peakOutstanding, peakSendBytes: this.peakSend };
  }
}
