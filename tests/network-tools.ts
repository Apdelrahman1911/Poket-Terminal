import type { Page, WebSocketRoute } from '@playwright/test';

// Test-only bounded FIFO transport. Never install it on the public site.
export async function delayedNetwork(page: Page) {
  const policy = { upMs: 0, downMs: 0, downBytesPerSecond: Infinity, dropInputAcks: false };
  const stats = { inputs: 0, terminalReplies: 0, backendAcks: 0, deliveredAcks: 0, queuedBytes: 0, peakBytes: 0, peakMessages: 0, overflow: false, deliveredBinaryBytes: 0 };
  let pendingMessages = 0;
  const cleanups = new Set<() => void>();
  await page.routeWebSocket('**/api/terminal/*', route => {
    const server = route.connectToServer(); let closed = false;
    const lanes: { queue: { data: string | Buffer; due: number; bytes: number; type: string }[]; timer?: ReturnType<typeof setTimeout> }[] = [{ queue: [] }, { queue: [] }];
    const cleanup = () => {
      if (closed) return; closed = true;
      for (const lane of lanes) {
        clearTimeout(lane.timer);
        for (const item of lane.queue) { stats.queuedBytes -= item.bytes; pendingMessages--; }
        lane.queue.length = 0;
      }
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    route.onClose(() => { cleanup(); void server.close().catch(() => {}); });
    server.onClose(() => { cleanup(); void route.close().catch(() => {}); });
    const send = (target: WebSocketRoute, data: string | Buffer, laneIndex: number) => {
      if (closed) return;
      const type = typeof data === 'string' ? JSON.parse(data).type : 'binary';
      if (laneIndex === 0 && type === 'input') {
        stats.inputs++;
        if (/^\x1b\[\d+;\d+R$/.test(JSON.parse(data as string).data)) stats.terminalReplies++;
      }
      if (laneIndex === 1 && type === 'input_ack') { stats.backendAcks++; if (policy.dropInputAcks) return; }
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.length, lane = lanes[laneIndex]!;
      const delay = laneIndex === 0 ? policy.upMs : policy.downMs;
      const due = Math.max(performance.now() + delay, lane.queue.at(-1)?.due || 0) + (laneIndex === 1 ? bytes / policy.downBytesPerSecond * 1000 : 0);
      stats.queuedBytes += bytes; pendingMessages++;
      stats.peakBytes = Math.max(stats.peakBytes, stats.queuedBytes); stats.peakMessages = Math.max(stats.peakMessages, pendingMessages);
      lane.queue.push({ data, due, bytes, type });
      if (stats.queuedBytes > 256 * 1024 || pendingMessages > 128) { stats.overflow = true; cleanup(); void route.close(); return; }
      const drain = () => {
        lane.timer = undefined;
        if (closed) return;
        const first = lane.queue[0]; if (!first) return;
        if (first.due > performance.now()) { lane.timer = setTimeout(drain, Math.max(1, first.due - performance.now())); return; }
        lane.queue.shift(); stats.queuedBytes -= first.bytes; pendingMessages--;
        try { target.send(first.data); } catch { cleanup(); return; }
        if (laneIndex === 1 && first.type === 'input_ack') stats.deliveredAcks++;
        if (laneIndex === 1 && first.type === 'binary') stats.deliveredBinaryBytes += first.bytes;
        if (lane.queue.length) lane.timer = setTimeout(drain, Math.max(1, lane.queue[0]!.due - performance.now()));
      };
      if (!lane.timer) drain();
    };
    route.onMessage(data => send(server, data, 0)); server.onMessage(data => send(route, data, 1));
  });
  return { policy, stats, close: () => { for (const cleanup of cleanups) cleanup(); } };
}
