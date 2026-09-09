import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedChannel } from '../client/channel.js';
import { CloseGate } from '../client/close-gate.js';

class FakeSocket {
  readyState = 1; protocol = 'pocketdesktop.v1'; bufferedAmount = 0; sent = []; closes = 0;
  send(data) { this.sent.push(data); }
  close() { this.closes++; this.readyState = 2; }
  finish() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  receive(n) { this.onmessage?.({ data: new ArrayBuffer(n) }); }
}
const delay = ms => new Promise(r => setTimeout(r, ms));

test('channel bounds incoming frame, outgoing frame and send transport', () => {
  for (const fail of [c => c.socket.receive(65537), c => c.send(new Uint8Array(16385)), c => { c.socket.bufferedAmount = 65536; c.send(new Uint8Array(1)); }]) {
    let failed = 0;
    const c = new BoundedChannel('wss://synthetic.invalid', 'fixture', () => failed++, () => false, FakeSocket);
    fail(c); assert.equal(c.disposed, true); assert.equal(failed, 1); assert.equal(c.socket.closes, 1);
    c.socket.finish();
  }
});
test('one ACK timer, render wait deadline and full disposal', async () => {
  let failed = 0;
  const c = new BoundedChannel('wss://synthetic.invalid', 'fixture', () => failed++, () => true, FakeSocket);
  for (let i = 0; i < 6; i++) c.socket.receive(65536);
  assert.equal(c.stats().ackTimers, 1); assert.equal(c.socket.sent.length, 0);
  c.stalledAt = performance.now() - 2001;
  await delay(40);
  assert.equal(failed, 1); assert.equal(c.stats().ackTimers, 0); assert.equal(c.pending(), false);
  c.socket.finish(); await c.closed;
});
test('ACK advances only after bounded renderer drains; dispose cancels timers and input', async () => {
  let pending = true;
  const c = new BoundedChannel('wss://synthetic.invalid', 'fixture', () => assert.fail(), () => pending, FakeSocket);
  c.socket.receive(100); await delay(30); assert.equal(c.socket.sent.length, 0);
  pending = false; await delay(30);
  assert.deepEqual(JSON.parse(c.socket.sent[0]), { type: 'ack', bytes: 100 });
  c.dispose(); c.send(new Uint8Array(8)); assert.equal(c.socket.sent.length, 1);
  c.socket.finish(); await c.closed;
});
test('fake stuck native close: 10,000 hide/foreground cycles retain ONE close waiter and ONE latest intent', async () => {
  const c = new BoundedChannel('wss://synthetic.invalid', 'fixture', () => assert.fail(), () => false, FakeSocket);
  let reactions = 0;
  const originalThen = c.closed.then.bind(c.closed);
  c.closed.then = (...args) => { reactions++; return originalThen(...args); };
  const gate = new CloseGate(); c.dispose(); gate.retire(c.closed);
  let resumed = -1;
  for (let i = 0; i < 10000; i++) {
    gate.cancel(); assert.equal(gate.request(() => { resumed = i; }), true);
  }
  assert.equal(reactions, 1);
  assert.deepEqual(gate.stats(), { closeWaiters: 1, connectionIntents: 1 });
  assert.equal(resumed, -1); assert.equal(c.socket.closes, 1);
  c.socket.finish(); await delay(0);
  assert.equal(resumed, 9999); assert.deepEqual(gate.stats(), { closeWaiters: 0, connectionIntents: 0 });
});
test('stuck-close cancellation cannot reconnect a hidden/logged-out generation', async () => {
  let finish, resumed = 0;
  const gate = new CloseGate(); gate.retire(new Promise(r => { finish = r; }));
  gate.request(() => resumed++); gate.cancel(); finish(); await delay(0);
  assert.equal(resumed, 0); assert.equal(gate.waiting, false);
});
