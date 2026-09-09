import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCard } from '../src/client/session-card.js';

test('Cards: exact reported activity has distinct tones and accessible labels; no inferred legacy/shell activity', () => {
  for (const [activity, tone, label] of [['working', 'working', 'CLI: Working'], ['awaiting_input', 'input', 'CLI: Awaiting input'], ['ready', 'ready', 'CLI: Ready · awaiting prompt']]) {
    assert.deepEqual(sessionCard({ state: 'running', activity }, true), { tone, lifecycle: 'running', label });
  }
  for (const activity of [undefined, 'unavailable', 'unknown', '', 'Ready', 'working ', 'awaiting input', 'error']) {
    const presentation = sessionCard({ state: 'running', activity }, true);
    assert.deepEqual(presentation, { tone: 'unreported', lifecycle: 'running', label: 'Running · activity not reported' });
    assert.doesNotMatch(presentation.label, /Unknown|[Ee]rror|failed/);
  }
});

test('Cards: stopped/error/starting/stopping lifecycle takes precedence over conflicting activity', () => {
  for (const activity of ['working', 'ready', 'awaiting_input']) {
    for (const lifecycle of ['starting', 'stopping', 'stopped', 'exited', 'error'] as const) {
      const state = lifecycle === 'starting' ? 'starting' : ['stopped', 'exited', 'error'].includes(lifecycle) ? 'stopped' : 'running';
      const presentation = sessionCard({ state, lifecycle, activity }, true);
      assert.equal(presentation.lifecycle, lifecycle); assert.equal(presentation.tone, lifecycle === 'exited' ? 'stopped' : lifecycle);
    }
    assert.equal(sessionCard({ state: 'stopped', lifecycle: 'running', activity }, true).tone, 'stopped');
    assert.equal(sessionCard({ state: 'starting', lifecycle: 'running', activity }, true).tone, 'starting');
    assert.equal(sessionCard({ state: 'stopped', lifecycle: 'error', activity }, true).tone, 'error');
    assert.deepEqual(sessionCard({ state: 'running', lifecycle: 'unknown', activity }, true), { tone: 'stale', lifecycle: 'unknown', label: 'State unconfirmed' });
  }
});

test('Cards: stale/fetch-failure presentation is separate from healthy unreported running, even with cached working/error', () => {
  for (const lifecycle of ['starting', 'running', 'stopping', 'stopped', 'exited', 'error', 'unknown'] as const) {
    assert.deepEqual(sessionCard({ state: 'running', lifecycle, activity: 'working' }, false), { tone: 'stale', lifecycle: 'unknown', label: 'Status stale · refreshing' });
  }
  const input = { state: 'running' as const, activity: 'unavailable' };
  assert.notEqual(sessionCard(input, false).tone, sessionCard(input, true).tone);
  assert.equal(sessionCard(input, true).label, 'Running · activity not reported');
});
