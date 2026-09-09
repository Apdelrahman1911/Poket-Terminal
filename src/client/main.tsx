import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActiveTerminal, TerminalState } from './terminal';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { useViewportLayout } from './viewport';
import { request } from './api';
import { CopyOutput } from './copy';
import { sessionCard } from './session-card';

interface AuthState { authenticated: boolean; csrf?: string; expiresAt?: number; setupRequired?: boolean; defaultCwd?: string; desktop?: boolean }
interface Session { id: string; label: string; kind: 'codex' | 'shell'; cwd: string; state: 'starting' | 'running' | 'stopped'; ssh: string; stopped_reason: string | null; lifecycle?: 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'error' | 'unknown'; activity?: 'working' | 'awaiting_input' | 'ready' | 'unknown' | 'unavailable'; activitySource?: string; observedAt?: number }
interface Project { name: string; path: string }
// Clipboard permission/read promises cannot be cancelled. Permit one globally, never queue more.
let clipboardReadPending = false;
function useVisible() {
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    let frozen = false;
    const change = () => setVisible(!frozen && document.visibilityState === 'visible');
    const hide = () => { frozen = true; setVisible(false); };
    const show = () => { frozen = false; change(); };
    document.addEventListener('visibilitychange', change); document.addEventListener('freeze', hide); document.addEventListener('resume', show);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { document.removeEventListener('visibilitychange', change); document.removeEventListener('freeze', hide); document.removeEventListener('resume', show); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, []);
  return visible;
}
function TerminalPane({ session, csrf, expired, attachment }: { session: Session; csrf: string; expired: () => void; attachment: (id: string, state: TerminalState) => void }) {
  const host = useRef<HTMLDivElement>(null), active = useRef<ActiveTerminal | null>(null);
  const [version, setVersion] = useState(0), [ctrl, setCtrl] = useState(false), [alt, setAlt] = useState(false);
  const modifiers = useRef({ ctrl, alt }); modifiers.current = { ctrl, alt };
  const [status, setStatus] = useState<TerminalState>({ connected: false, controller: false, message: 'Connecting…' });
  useEffect(() => {
    let stale = false;
    setStatus({ connected: false, controller: false, message: 'Connecting…' });
    attachment(session.id, { connected: false, controller: false, message: 'Connecting…' });
    const terminal = new ActiveTerminal(host.current!, session.id, csrf, state => { if (!stale) { setStatus(state); attachment(session.id, state); } }, expired, data => {
      const mods = modifiers.current;
      if (mods.ctrl && data.length === 1 && /[a-zA-Z@\[\]\\^_?]/.test(data)) data = data === '?' ? '\x7f' : String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
      if (mods.alt) data = '\x1b' + data;
      if (mods.ctrl || mods.alt) { setCtrl(false); setAlt(false); }
      return data;
    });
    active.current = terminal;
    return () => { stale = true; active.current = null; terminal.dispose(); attachment(session.id, { connected: false, controller: false, message: 'Not attached' }); };
  }, [session.id, csrf, version, expired, attachment]);
  const paste = async () => {
    const initiating = active.current;
    if (!initiating || clipboardReadPending) return;
    clipboardReadPending = true;
    try {
      const value = await navigator.clipboard.readText();
      if (active.current === initiating) initiating.paste(value); // disposed terminals also refuse input
    } catch {
      if (active.current === initiating) setStatus(s => ({ ...s, message: 'Clipboard denied. Use the keyboard paste action.' }));
    } finally { clipboardReadPending = false; }
  };
  return <section className="terminal-pane" aria-label="Active terminal">
    <div className="connection-bar"><span className={status.connected ? 'dot live' : 'dot'} /><span role="status" data-testid="connection-status">{status.message}</span>
      {status.connected && !status.controller && <button onClick={() => active.current?.takeControl()}>Take control</button>}
      {status.connected && <button disabled={!status.controller} title="Exit tmux history without sending keys to the job. Wheel/swipe scroll; Shift+drag selects text. Mouse-aware apps handle their own scrolling." onClick={() => active.current?.exitHistory()}>Exit history</button>}
      {!status.connected && <button onClick={() => setVersion(n => n + 1)}>Reconnect</button>}
      {status.connected && <button onClick={() => { active.current?.dispose(); setStatus({ connected: false, controller: false, message: 'Disconnected. The job continues in tmux.' }); attachment(session.id, { connected: false, controller: false, message: 'Detached' }); }}>Disconnect</button>}
      <CopyOutput terminal={status.connected ? active.current : null} id={session.id} csrf={csrf} expired={expired} />
    </div>
    <div ref={host} className="terminal-host" data-testid="terminal-host" />
    <div className="keys" aria-label="Terminal keys">
      <button aria-pressed={ctrl} onClick={() => { setCtrl(!ctrl); active.current?.focus(); }}>Ctrl</button>
      <button aria-pressed={alt} onClick={() => { setAlt(!alt); active.current?.focus(); }}>Alt</button>
      {Object.entries({ Esc: '\x1b', Tab: '\t', '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C', Enter: '\r' }).map(([label, key]) => <button key={label} onClick={() => { active.current?.input(key); active.current?.focus(); }}>{label}</button>)}
      <button onClick={() => void paste()}>Paste</button>
    </div>
  </section>;
}
function App() {
  useViewportLayout();
  const visible = useVisible();
  const authGeneration = useRef(0), catalogGeneration = useRef(0);
  const [auth, setAuth] = useState<AuthState | null>(null), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]), [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState(sessionStorage.getItem('pt-selected') || ''), [showCreate, setShowCreate] = useState(false);
  const selectedRef = useRef(selected);
  const [selectedMetadata, setSelectedMetadata] = useState<Session | null>(null);
  const [offset, setOffset] = useState(0), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [reload, setReload] = useState(0), [catalogFresh, setCatalogFresh] = useState(false), [runningCount, setRunningCount] = useState(0);
  const [attached, setAttached] = useState<{ id: string; state: TerminalState } | null>(null);
  const attachment = useCallback((id: string, state: TerminalState) => setAttached({ id, state }), []);
  const [label, setLabel] = useState(''), [kind, setKind] = useState<'codex' | 'shell'>('codex'), [cwd, setCwd] = useState('');
  const [rename, setRename] = useState(false), [renameText, setRenameText] = useState('');
  const expired = useCallback(() => { authGeneration.current++; setAuth({ authenticated: false }); setSessions([]); setSelectedMetadata(null); setCatalogFresh(false); setProjects([]); setError('Login expired or revoked. Your jobs have not been stopped.'); }, []);
  const choose = (id: string) => { if (selectedRef.current !== id) catalogGeneration.current++; selectedRef.current = id; setSelected(id); if (id) sessionStorage.setItem('pt-selected', id); else sessionStorage.removeItem('pt-selected'); setRename(false); };
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(), generation = authGeneration.current;
    void request<AuthState>('/api/auth', 'GET', undefined, undefined, controller.signal).then(value => { if (controller.signal.aborted || generation !== authGeneration.current) return; setAuth(value); if (!value.authenticated) { setSessions([]); setSelectedMetadata(null); setCatalogFresh(false); setProjects([]); } }).catch(err => { if (err.name !== 'AbortError') setError('Cannot reach the secure service.'); });
    return () => controller.abort();
  }, [visible]);
  useEffect(() => {
    if (!visible || !auth?.authenticated || !auth.expiresAt) return;
    const timer = setTimeout(expired, Math.max(0, auth.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [visible, auth?.authenticated, auth?.expiresAt, expired]);
  const refresh = useCallback(async () => { catalogGeneration.current++; setReload(n => n + 1); }, []);
  useEffect(() => {
    setCatalogFresh(false);
    if (!visible || !auth?.authenticated) return;
    // A single completion-scheduled catalog poll: one request and one timer (the
    // request deadline OR the next poll). No hidden-tab timer or terminal data.
    let ended = false, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      controller = new AbortController();
      const signal = controller.signal, generation = authGeneration.current, catalog = catalogGeneration.current;
      timer = setTimeout(() => controller?.abort(), 8000);
      try {
        const query = new URLSearchParams({ limit: '20', offset: String(offset), ...(selected ? { selected } : {}) });
        const result = await request<{ sessions: Session[]; selectedSession: Session | null; nextOffset: number | null; runningCount: number }>(`/api/sessions?${query}`, 'GET', undefined, undefined, signal);
        if (ended || signal.aborted || generation !== authGeneration.current || catalog !== catalogGeneration.current) return;
        setSessions(result.sessions.slice(0, 20)); setSelectedMetadata(result.selectedSession);
        setNextOffset(result.nextOffset); setRunningCount(result.runningCount); setCatalogFresh(true);
      } catch (err) {
        if (!ended && generation === authGeneration.current && catalog === catalogGeneration.current) {
          setCatalogFresh(false);
          if ((err as Error).message === 'authentication_required') expired();
        }
      } finally {
        clearTimeout(timer);
        if (!ended && generation === authGeneration.current) timer = setTimeout(() => void tick(), 3000);
      }
    };
    void tick();
    return () => { ended = true; controller?.abort(); clearTimeout(timer); };
  }, [visible, auth?.authenticated, selected, offset, reload, expired]);
  useEffect(() => {
    if (!visible || !auth?.authenticated) return;
    const controller = new AbortController(), generation = authGeneration.current;
    void request<{ projects: Project[]; defaultCwd: string }>('/api/projects', 'GET', undefined, undefined, controller.signal).then(value => { if (controller.signal.aborted || generation !== authGeneration.current) return; setProjects(value.projects); setCwd(current => current || value.defaultCwd); }).catch(err => { if (err.name !== 'AbortError' && generation === authGeneration.current) { if (err.message === 'authentication_required') expired(); else setError(err.message); } });
    return () => controller.abort();
  }, [visible, auth?.authenticated, expired]);
  const selectedSession = sessions.find(s => s.id === selected) || (selectedMetadata?.id === selected ? selectedMetadata : undefined);
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const value = password, generation = ++authGeneration.current; setPassword('');
    try { const result = await request<AuthState>('/api/login', 'POST', { password: value }); if (generation === authGeneration.current) setAuth(result); } catch (e) { setError((e as Error).message === 'login_throttled' ? 'Too many attempts. Wait 15 minutes before retrying.' : (e as Error).message === 'owner_setup_required' ? 'The owner must initialize the password privately over SSH.' : 'Login failed.'); } finally { setBusy(false); }
  }
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); try { await work(); } catch (e) { if ((e as Error).message === 'authentication_required') expired(); else setError((e as Error).message.replaceAll('_', ' ')); } finally { setBusy(false); }
  }
  function deleteEntry(session: Session) {
    if (!confirm(`Delete “${session.label}”? Remove entry only; project files/Codex history kept.`)) return;
    const generation = authGeneration.current;
    void action(async () => {
      await request(`/api/sessions/${session.id}`, 'DELETE', { confirm: session.id }, auth?.csrf);
      if (generation !== authGeneration.current) return;
      catalogGeneration.current++; // Reject every pre-delete list response, including pagination.
      setSessions(current => current.filter(row => row.id !== session.id));
      setSelectedMetadata(current => current?.id === session.id ? null : current);
      void refresh();
      if (selectedRef.current === session.id) choose(''); // Never detach a different selected job.
    });
  }
  if (!auth?.authenticated) return <main className="login-shell"><div className="brand-mark">›_</div><h1>PocketTerminal</h1><p className="muted">Your VPS. Your sessions. Securely in your pocket.</p>
    <form onSubmit={event => void login(event)} className="login-card"><h2>Owner access</h2><p>This terminal runs as <strong>root</strong>. Keep your password private.</p>
      {auth?.setupRequired ? <p className="notice">Secure setup is pending. Initialize the owner password through private SSH; there is no default password.</p> : <><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" maxLength={256} required value={password} onChange={e => setPassword(e.target.value)} /><button className="primary" disabled={busy || !auth}>{busy ? 'Signing in…' : 'Sign in'}</button></>}
      {error && <p role="alert">{error}</p>}</form><small>No signup. No terminal output is stored by this website.</small></main>;
  return <main className="workspace"><header className="topbar"><div><strong className="wordmark">›_ PocketTerminal</strong><span className="owner-tag">ROOT · PRIVATE</span></div>{auth.desktop && <a href="/desktop/">Desktop</a>}<button onClick={() => void action(async () => { authGeneration.current++; setAuth({ authenticated: false }); setSessions([]); setSelectedMetadata(null); setCatalogFresh(false); setProjects([]); await request('/api/logout', 'POST', {}, auth.csrf); })}>Log out</button></header>
    {error && <div className="alert" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    <div className="workspace-body"><aside className="sidebar"><div className="section-heading"><h2>Sessions <small>{runningCount}/20</small></h2><button aria-label="New session" className="primary" onClick={() => setShowCreate(!showCreate)}>+ New</button></div>
      {showCreate && <form className="create-form" onSubmit={e => { e.preventDefault(); void action(async () => { const result = await request<{ session: Session }>('/api/sessions', 'POST', { label: label || (kind === 'codex' ? 'Codex' : 'Shell'), kind, cwd }, auth.csrf); catalogGeneration.current++; setSessions(current => [result.session, ...current].slice(0, 20)); setOffset(0); choose(result.session.id); void refresh(); setShowCreate(false); setLabel(''); }); }}>
        <label>Label<input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} placeholder="New session" /></label>
        <label>Kind<select value={kind} onChange={e => setKind(e.target.value as 'codex' | 'shell')}><option value="codex">Codex · owner configuration</option><option value="shell">Interactive shell</option></select></label>
        <label>Working directory<select value={cwd} onChange={e => setCwd(e.target.value)}>{projects.map(p => <option value={p.path} key={p.path}>{p.name}</option>)}</select></label>
        <small>Codex has full access and never asks for approval. Starting it may incur provider charges.</small><button disabled={busy || runningCount >= 20} className="primary">Create session</button></form>}
      <nav className="session-list" aria-label="Sessions">{sessions.map(session => {
        const presentation = sessionCard(session, visible && catalogFresh);
        const connection = selected !== session.id ? 'not attached' : !visible ? 'suspended' : attached?.id === session.id && attached.state.connected
          ? attached.state.controller ? 'controlling' : 'view only' : attached?.id === session.id && attached.state.message === 'Connecting…' ? 'connecting' : 'detached';
        return <button key={session.id} data-session-id={session.id} data-state={presentation.tone} aria-current={selected === session.id ? 'true' : undefined} onClick={() => choose(session.id)} className="session-item">
          <span className="dot" aria-hidden="true" />
          <span><strong>{session.label}</strong><small data-testid="lifecycle">{session.kind} · {presentation.lifecycle}</small><small className="session-state" data-testid="activity" title="Process lifecycle takes precedence over CLI activity. Activity not reported is not a failure; Ready is not proof that the last task succeeded.">{presentation.label}</small><small data-testid="attachment">Browser: {connection}</small></span>
        </button>;
      })}</nav>
      {!sessions.length && <p className="muted empty-list">Start a session. It keeps running when you leave.</p>}
      <div className="catalog-actions"><button className="refresh" disabled={busy} onClick={() => void refresh()}>Refresh sessions</button>
        {offset > 0 && <button onClick={() => { catalogGeneration.current++; setOffset(Math.max(0, offset - 20)); }}>Newer sessions</button>}
        {nextOffset !== null && <button onClick={() => { catalogGeneration.current++; setOffset(nextOffset); }}>Load older sessions</button>}</div>
      <small className="catalog-state" role="status">{!visible ? 'Status paused' : catalogFresh ? 'Live metadata · updates every3s · 20 cards/page' : 'Status unknown · reconnecting…'}</small>
      <details className="activity-help"><summary>Activity meaning</summary><p>Lifecycle is process state; CLI activity is the native title of the active pane/window of new Codex sessions, not output guessing. Ready means ready for input, not that the last task succeeded. Nonfatal CLI/API errors are not detected; Error means a verified start/exit failure. Existing/older Codex sessions lack activity reporting and keep running normally; new Codex sessions support it. Shells and inactive/replaced programs may not report activity either. Activity not reported is not a failure. Browser attachment is separate.</p><p>Colors: blue working; amber input; green ready; violet starting; orange stopping; grey stopped/exited; red error. Dashed teal: activity not reported. Dotted: stale/unconfirmed. A light border marks selection; an outer outline marks keyboard focus.</p></details>
      <p className="sidebar-note">500-line browser scrollback · 2,000-line tmux history.<br />Inactive sessions use no browser terminals.</p>
    </aside><div className="terminal-area">{selectedSession ? <><div className="session-header"><div><h1>{selectedSession.label}</h1><small>{selectedSession.cwd}</small></div><div className="session-actions"><button onClick={() => { setRenameText(selectedSession.label); setRename(!rename); }}>Rename</button>{selectedSession.state === 'stopped' ? <button className="danger" disabled={busy} onClick={() => deleteEntry(selectedSession)}>Delete</button> : <button className="danger" disabled={busy} onClick={() => { if (confirm(`Stop “${selectedSession.label}”? This terminates only this job and cannot be undone.`)) void action(async () => { await request(`/api/sessions/${selectedSession.id}/stop`, 'POST', { confirm: selectedSession.id }, auth.csrf); await refresh(); }); }}>Stop</button>}</div></div>
      {rename && <form className="rename-form" onSubmit={e => { e.preventDefault(); void action(async () => { await request(`/api/sessions/${selectedSession.id}`, 'PATCH', { label: renameText }, auth.csrf); setRename(false); await refresh(); }); }}><input aria-label="New session label" maxLength={80} value={renameText} onChange={e => setRenameText(e.target.value)} /><button disabled={busy}>Save name</button></form>}
      {visible && selectedSession.state === 'running' ? <TerminalPane key={selectedSession.id} session={selectedSession} csrf={auth.csrf!} expired={expired} attachment={attachment} /> : <div className="empty-terminal"><h2>{!visible ? 'Terminal suspended' : selectedSession.state === 'starting' ? 'Starting · not started yet' : selectedSession.lifecycle === 'error' ? 'Job exited with error' : selectedSession.lifecycle === 'exited' ? 'Job exited' : 'Session stopped'}</h2>{visible && selectedSession.stopped_reason && <small>{selectedSession.stopped_reason.replaceAll('_', ' ')}</small>}<p>{visible ? 'Jobs are never restarted automatically after exit or a VPS reboot. Create a new terminal and intentionally resume any Codex history with the CLI.' : 'Browser resources released. Your job is still running.'}</p></div>}
      <details className="ssh-help"><summary>Connect from SSH</summary><code>{selectedSession.ssh}</code><button onClick={() => void navigator.clipboard.writeText(selectedSession.ssh).catch(() => setError('Select and copy the SSH command manually.'))}>Copy SSH command</button><small>Detach with Ctrl+B, then D (also works in the browser). Browsers and the paired Telegram bot share input control. SSH attaches directly and is outside that controller rule.</small></details>
    </> : <div className="empty-terminal"><div className="brand-mark">›_</div><h1>A small window into your VPS</h1><p>Select a session or create one. Closing this page detaches the viewer, not the job.</p><small>Running tmux jobs survive browser/backend disconnects, not a VPS reboot.</small></div>}</div></div></main>;
}
// Defense in depth until the edge enforces HTTP -> HTTPS: never mount a password
// field or start auth requests on plaintext. Do not infer TLS from forwarded headers.
if (location.protocol === 'http:') { const secure = new URL('/', location.href); secure.protocol = 'https:'; location.replace(secure.href); }
else if (location.protocol !== 'https:') throw new Error('HTTPS is required');
else createRoot(document.getElementById('root')!).render(<App />);
