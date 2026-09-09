import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { boundedText } from './snapshot';

const MAX_OUTPUT = 128 * 1024, MAX_TRANSPORT = 256 * 1024, MAX_INPUT = 16 * 1024;
// This is a network round-trip deadline, NOT the server's 250 ms PTY-write deadline.
// A simulated 2.3 s RTT made the former 2 s limit reject already-written input.
// Match the 5 s output-consumption budget; keep one fixed, non-renewable timer per chunk.
const INPUT_ACK_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();
export type TerminalState = { connected: boolean; controller: boolean; message: string };
export class ActiveTerminal {
  private term?: Terminal;
  private fit?: FitAddon;
  private ws?: WebSocket;
  private subscriptions: { dispose(): void }[] = [];
  private observer?: ResizeObserver;
  private frame = 0;
  private alive = true;
  private queued = 0;
  private consumed = 0;
  private pendingInput = '';
  private inputInFlight = false;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private controller = false;
  private cols = 0;
  private rows = 0;
  private touch?: { id: number; y: number; remainder: number; moved: boolean };
  constructor(private element: HTMLElement, id: string, csrf: string,
    private state: (s: TerminalState) => void, private expired: () => void,
    private modify: (s: string) => string) {
    this.term = new Terminal({ scrollback: 500, cols: 100, rows: 30, fontSize: 14, lineHeight: 1.12,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', cursorBlink: false,
      convertEol: false, disableStdin: true, allowProposedApi: false,
      theme: { background: '#0b1018', foreground: '#dde6ef', cursor: '#74e2c3', selectionBackground: '#315466' } });
    this.fit = new FitAddon(); this.term.loadAddon(this.fit); this.term.open(element);
    this.subscriptions.push(this.term.onData(data => this.input(data.startsWith('\x1b[<') ? data : this.modify(data))));
    // Capture paste before xterm can make a large private queue. There is no hidden-session clipboard/output cache.
    element.addEventListener('paste', this.onPaste, true);
    element.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    element.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: false });
    element.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false });
    element.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    element.addEventListener('touchcancel', this.onTouchEnd, { capture: true, passive: false });
    this.observer = new ResizeObserver(this.scheduleResize); this.observer.observe(element);
    window.visualViewport?.addEventListener('resize', this.scheduleResize);
    document.addEventListener('visibilitychange', this.hide);
    document.addEventListener('freeze', this.suspend);
    window.addEventListener('pagehide', this.suspend);
    this.ws = new WebSocket(`${location.origin.replace('https:', 'wss:')}/api/terminal/${id}`, ['pocketterminal.v1', `csrf.${csrf}`]);
    this.ws.binaryType = 'arraybuffer';
    const ws = this.ws;
    ws.onopen = () => { if (!this.alive) return ws.close(); this.resize(true); this.state({ connected: true, controller: false, message: 'Attached · waiting for control state' }); };
    ws.onmessage = event => {
      if (!this.alive) return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.byteLength > 8192 || this.queued + bytes.byteLength > MAX_OUTPUT) return this.fail('Output budget reached. Reconnect to redraw from tmux; the job is still running.');
        this.queued += bytes.byteLength;
        // Imperative byte stream; ACK is sent ONLY after xterm's parser/write callback consumes it.
        this.term?.write(bytes, () => {
          if (!this.alive) return;
          this.queued -= bytes.byteLength; this.consumed += bytes.byteLength;
          this.send({ type: 'ack', bytes: this.consumed });
        });
      } else if (typeof event.data === 'string' && event.data.length <= 2048) {
        let message: { type?: string; controller?: boolean; code?: string; owner?: string };
        try { message = JSON.parse(event.data); } catch { return this.fail('Invalid server message.'); }
        if (message.type === 'control') {
          const lostControl = this.controller && message.controller !== true;
          this.controller = message.controller === true;
          if (this.term) this.term.options.disableStdin = !this.controller;
          if (lostControl) {
            this.touch = undefined;
            this.pendingInput = ''; this.inputInFlight = false;
            if (this.inputTimer) clearTimeout(this.inputTimer);
          }
          this.state({ connected: true, controller: this.controller, message: this.controller ? 'You control input & size' : message.owner === 'telegram' ? 'View only · Telegram controls input. Take control to reclaim.' : 'View only · another device controls input' });
          this.resize(true);
        } else if (message.type === 'input_ack') {
          this.inputInFlight = false;
          if (this.inputTimer) clearTimeout(this.inputTimer);
          this.flush();
        } else if (message.type === 'error') this.state({ connected: true, controller: this.controller, message: message.code === 'history_exit_failed' ? 'Could not exit history. Reconnect to redraw; no keys were sent to the job.' : 'View only. Take control before typing or scrolling.' });
      } else this.fail('Invalid server frame.');
    };
    ws.onerror = () => { if (this.alive) this.fail('Connection unavailable. Check your login, then reconnect. Jobs are not stopped.'); };
    ws.onclose = event => {
      if (!this.alive) return;
      if (event.code === 4001) { this.dispose(); this.expired(); return; }
      const reason = event.reason.includes('slow') || event.reason.includes('limit')
        ? 'Rendering fell behind; attachment released to protect memory. Reconnect for a fresh tmux redraw.'
        : event.reason === 'session_stopped' ? 'This session was stopped.' : 'Detached. Reconnect to the running job; no keystrokes will be replayed.';
      this.fail(reason);
    };
    this.scheduleResize();
  }
  private hide = () => { if (document.visibilityState !== 'visible') this.suspend(); };
  private suspend = () => this.fail('Backgrounded · terminal resources released. The job continues in tmux.');
  private onPaste = (event: ClipboardEvent) => {
    event.preventDefault(); event.stopImmediatePropagation();
    const text = event.clipboardData?.getData('text/plain') || '';
    this.paste(text);
  };
  private onWheel = (event: WheelEvent) => {
    // xterm otherwise turns wheel into cursor keys in an alternate buffer with
    // no scrollback. Never let a scroll recall/edit a shell command.
    if (event.ctrlKey || event.metaKey) { event.stopImmediatePropagation(); return; }
    if (!this.alive || !this.controller || !this.term || this.term.modes.mouseTrackingMode === 'none') {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  private onTouchStart = (event: TouchEvent) => {
    this.touch = undefined;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    this.touch = { id: touch.identifier, y: touch.clientY, remainder: 0, moved: false };
    event.stopImmediatePropagation(); // no second xterm viewport gesture/momentum queue
  };
  private onTouchMove = (event: TouchEvent) => {
    const gesture = this.touch, touch = event.touches[0];
    if (!gesture || event.touches.length !== 1 || touch?.identifier !== gesture.id) { this.touch = undefined; return; }
    event.preventDefault(); event.stopImmediatePropagation(); gesture.moved = true;
    gesture.remainder += gesture.y - touch.clientY; gesture.y = touch.clientY;
    const screen = this.element.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!screen || !this.term?.element) return;
    const line = Math.max(1, screen.height / this.term.rows);
    if (Math.abs(gesture.remainder) < line) return;
    const deltaY = Math.sign(gesture.remainder); gesture.remainder %= line;
    // Feed the public DOM wheel path: xterm encodes negotiated mouse reports and
    // tmux decides copy-mode vs a mouse-aware TUI. No application key guesses.
    this.term.element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 1, deltaY,
      clientX: Math.max(screen.left + 1, Math.min(screen.right - 1, touch.clientX)), clientY: Math.max(screen.top + 1, Math.min(screen.bottom - 1, touch.clientY)) }));
  };
  private onTouchEnd = (event: TouchEvent) => {
    if (this.touch) { event.stopImmediatePropagation(); if (this.touch.moved) event.preventDefault(); }
    this.touch = undefined;
  };
  private send(message: object) {
    const ws = this.ws;
    if (!this.alive || !ws || ws.readyState !== WebSocket.OPEN) return false;
    const value = JSON.stringify(message);
    if (ws.bufferedAmount + encoder.encode(value).length > MAX_TRANSPORT) { this.fail('Input connection is slow. Reconnect; queued input has been discarded.'); return false; }
    ws.send(value); return true;
  }
  private scheduleResize = () => { if (!this.alive || this.frame) return; this.frame = requestAnimationFrame(() => { this.frame = 0; this.resize(); }); };
  private resize(force = false) {
    if (!this.alive || !this.term || !this.fit) return;
    const size = this.fit.proposeDimensions(); if (!size) return;
    const cols = Math.max(2, Math.min(240, size.cols)), rows = Math.max(2, Math.min(100, size.rows));
    if (!force && this.cols === cols && this.rows === rows) return;
    this.cols = cols; this.rows = rows; this.term.resize(cols, rows);
    this.send({ type: 'resize', cols, rows });
  }
  input(value: string) {
    if (!this.alive || !this.controller || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.pendingInput.length + value.length > MAX_INPUT || encoder.encode(this.pendingInput).length + encoder.encode(value).length > MAX_INPUT) {
      this.fail('Paste/input exceeds the 16 KiB queue. Attachment released; use smaller chunks.'); return;
    }
    this.pendingInput += value; this.flush();
  }
  private flush() {
    if (!this.pendingInput || this.inputInFlight || !this.alive) return;
    // Bound by UTF-8 bytes without cutting a Unicode scalar or replaying across connections.
    let size = 0, end = 0;
    for (const char of this.pendingInput) { const n = encoder.encode(char).length; if (size + n > 4096) break; size += n; end += char.length; }
    const chunk = this.pendingInput.slice(0, end); this.pendingInput = this.pendingInput.slice(end);
    this.inputInFlight = true;
    if (!this.send({ type: 'input', data: chunk })) { this.inputInFlight = false; this.pendingInput = ''; return; }
    this.inputTimer = setTimeout(() => this.fail('Input was not acknowledged. Detached without replaying it.'), INPUT_ACK_TIMEOUT_MS);
  }
  paste(value: string) {
    if (value.length > MAX_INPUT - 16 || encoder.encode(value).length > MAX_INPUT - 16) { this.state({ connected: !!this.ws && this.ws.readyState === WebSocket.OPEN, controller: this.controller, message: 'Paste refused: use chunks below 16 KiB.' }); return; }
    if (this.alive && this.controller) this.term?.paste(value);
  }
  selection() { return this.term?.getSelection() || ''; }
  isActive() { return this.alive && this.ws?.readyState === WebSocket.OPEN; }
  visibleSnapshot() {
    const term = this.term;
    let text = '';
    if (term && this.alive) {
      const buffer = term.buffer.active;
      for (let y = buffer.viewportY; y < buffer.viewportY + term.rows && text.length <= 65536; y++) {
        text += (buffer.getLine(y)?.translateToString(true).slice(0, 65536) || '') + '\n';
      }
    }
    return boundedText(text.replace(/\n$/, ''), 'visible');
  }
  focus() { this.term?.focus(); }
  takeControl() { this.send({ type: 'take_control' }); }
  exitHistory() { if (this.alive && this.controller) { this.term?.scrollToBottom(); this.send({ type: 'exit_history' }); } }
  private fail(message: string) {
    if (!this.alive) return;
    this.dispose(); this.state({ connected: false, controller: false, message });
  }
  dispose() {
    if (!this.alive) return;
    this.alive = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.inputTimer) clearTimeout(this.inputTimer);
    this.pendingInput = ''; this.inputInFlight = false; this.queued = 0;
    this.touch = undefined;
    this.observer?.disconnect(); this.observer = undefined;
    window.visualViewport?.removeEventListener('resize', this.scheduleResize);
    document.removeEventListener('visibilitychange', this.hide);
    document.removeEventListener('freeze', this.suspend);
    window.removeEventListener('pagehide', this.suspend);
    this.element.removeEventListener('paste', this.onPaste, true);
    this.element.removeEventListener('wheel', this.onWheel, true);
    this.element.removeEventListener('touchstart', this.onTouchStart, true);
    this.element.removeEventListener('touchmove', this.onTouchMove, true);
    this.element.removeEventListener('touchend', this.onTouchEnd, true);
    this.element.removeEventListener('touchcancel', this.onTouchEnd, true);
    for (const sub of this.subscriptions) sub.dispose(); this.subscriptions.length = 0;
    const ws = this.ws; this.ws = undefined;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; if (ws.readyState < WebSocket.CLOSING) ws.close(1000, 'page_detach'); }
    this.term?.dispose(); this.term = undefined; this.fit = undefined;
    this.element.replaceChildren();
  }
}
