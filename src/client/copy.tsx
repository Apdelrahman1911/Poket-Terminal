import { useCallback, useEffect, useRef, useState } from 'react';
import { ActiveTerminal } from './terminal';
import { request } from './api';
import { boundedText, COPY_BYTES, COPY_LINES, Snapshot } from './snapshot';

// OS clipboard promises cannot be cancelled. One bounded write globally, no queue;
// never start a write from an asynchronous capture/permission completion.
let clipboardWritePending = false;
export function CopyOutput({ terminal, id, csrf, expired }: { terminal: ActiveTerminal | null; id: string; csrf: string; expired: () => void }) {
  const [open, setOpen] = useState<ActiveTerminal | null>(null), close = useCallback(() => setOpen(null), []);
  useEffect(() => { setOpen(null); }, [terminal]);
  return <><button disabled={!terminal?.isActive()} onClick={() => setOpen(terminal)}>Copy output</button>
    {open === terminal && terminal?.isActive() && <CopyDialog key={id} terminal={terminal} id={id} csrf={csrf} expired={expired} close={close} />}</>;
}
function CopyDialog({ terminal, id, csrf, expired, close }: { terminal: ActiveTerminal; id: string; csrf: string; expired: () => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true), generation = useRef(0), capture = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => terminal.selection() ? boundedText(terminal.selection(), 'selection') : terminal.visibleSnapshot());
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const valid = (version: number) => alive.current && version === generation.current && terminal.isActive() && document.visibilityState === 'visible';
  useEffect(() => {
    dialog.current!.showModal(); textarea.current?.focus();
    return () => { alive.current = false; generation.current++; capture.current?.abort(); clearTimeout(timer.current); dialog.current?.close(); };
  }, []);
  const visible = () => {
    generation.current++; capture.current?.abort(); capture.current = null; clearTimeout(timer.current);
    setBusy(false); setMessage(''); setSnapshot(terminal.visibleSnapshot());
  };
  const recent = async () => {
    if (capture.current || !terminal.isActive()) return;
    const version = ++generation.current, controller = new AbortController(); capture.current = controller;
    setBusy(true); setMessage(''); timer.current = setTimeout(() => controller.abort(), 6000);
    try {
      const result = await request<Snapshot>(`/api/sessions/${id}/snapshot`, 'POST', {}, csrf, controller.signal);
      if (!valid(version)) return;
      if (typeof result.text !== 'string' || result.text.length > COPY_BYTES || new TextEncoder().encode(result.text).length > COPY_BYTES || result.text.split('\n').length > COPY_LINES) throw new Error('snapshot_limit');
      setSnapshot({ text: result.text, truncated: result.truncated === true, source: 'recent' });
    } catch (error) {
      if (valid(version)) {
        if ((error as Error).message === 'authentication_required') expired();
        else setMessage('Recent output unavailable. Try the visible screen instead.');
      }
    } finally {
      if (capture.current === controller) { capture.current = null; clearTimeout(timer.current); if (valid(version)) setBusy(false); }
    }
  };
  const copy = async () => {
    const version = generation.current;
    if (!valid(version) || busy || !snapshot.text) return;
    if (clipboardWritePending) return setMessage('A clipboard write is still pending. Use Select all for native copying.');
    if (!navigator.clipboard?.writeText) return setMessage('Clipboard unavailable. Select all, then use your browser’s Copy menu.');
    clipboardWritePending = true;
    try { await navigator.clipboard.writeText(snapshot.text); if (valid(version)) setMessage('Copied.'); }
    catch { if (valid(version)) setMessage('Clipboard denied. Select all, then use your browser’s Copy menu.'); }
    finally { clipboardWritePending = false; }
  };
  return <dialog ref={dialog} className="copy-dialog" aria-labelledby="copy-title" onCancel={close}>
    <div className="copy-heading"><h2 id="copy-title">Copy CLI output</h2><button onClick={close}>Close copy</button></div>
    <p>Choose a snapshot, then Copy text. Nothing is saved by the website.</p>
    <div className="copy-actions"><button aria-pressed={snapshot.source === 'visible'} onClick={visible}>Copy visible</button><button disabled={busy} aria-pressed={snapshot.source === 'recent'} onClick={() => void recent()}>Copy recent</button></div>
    <small>{busy ? 'Reading bounded history…' : `${snapshot.source === 'recent' ? 'Recent active-pane history' : snapshot.source === 'selection' ? 'Selected text' : 'Visible screen'} · up to200 lines /64KiB${snapshot.truncated ? ' · truncated' : ''}`}. Full-screen apps expose only what tmux retains.</small>
    <textarea ref={textarea} aria-label="Output snapshot" readOnly spellCheck={false} wrap="off" value={snapshot.text} />
    <div className="copy-actions"><button className="primary" disabled={busy || !snapshot.text} onClick={() => void copy()}>Copy text</button><button onClick={() => { textarea.current?.focus(); textarea.current?.select(); }}>Select all</button></div>
    <p role="status">{message || 'On mobile, Select all or long-press this read-only text for the native Copy menu.'}</p>
  </dialog>;
}
