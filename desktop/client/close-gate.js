// Exactly one reaction on one retiring native WebSocket, plus one replaceable
// foreground intent. Visibility churn never creates suspended async connect()
// frames waiting on an uncloseable browser socket.
export class CloseGate {
  waiting = false;
  intent = null;
  waiters = 0;
  retire(closed) {
    if (this.waiting) throw new Error('Overlapping retiring sockets');
    this.waiting = true; this.waiters = 1;
    const complete = () => {
      this.waiting = false; this.waiters = 0;
      const intent = this.intent; this.intent = null;
      intent?.();
    };
    closed.then(complete, complete);
  }
  request(intent) {
    if (!this.waiting) return false;
    this.intent = intent; // latest intent wins, never append .then()/await
    return true;
  }
  cancel() { this.intent = null; }
  stats() { return { closeWaiters: this.waiters, connectionIntents: this.intent ? 1 : 0 }; }
}
