import RFB from '../vendor/novnc/core/rfb.js';
import { initLogging } from '../vendor/novnc/core/util/logging.js';
import { BoundedChannel } from './channel.js';
import { CloseGate } from './close-gate.js';

initLogging('none'); // Never log framebuffer, clipboard, native input or auth values.
const $ = id => document.getElementById(id);
const host = $('screen'), status = $('status');
let live = null, auth = null, generation = 0, controller = null, deadline = null, expiry = null;
const retirement = new CloseGate();
let busy = false, manualPause = false, frozen = false, fit = true, ctrl = false, alt = false;
let typeJob = null, typeTimer = null;
const visible = () => !frozen && document.visibilityState === 'visible';
function message(text, connected = false) { status.textContent = text; status.dataset.connected = String(connected); }
function controls(enabled) {
  document.querySelectorAll('[data-input]').forEach(button => { button.disabled = !enabled; });
  $('disconnect').disabled = !live && !busy;
  $('connect').disabled = busy || !!live;
}
function clearInput() {
  clearTimeout(typeTimer); typeTimer = null; typeJob = null;
  ctrl = alt = false; $('ctrl').setAttribute('aria-pressed', 'false'); $('alt').setAttribute('aria-pressed', 'false');
  $('type-text').value = $('clipboard-text').value = '';
}
function dispose(text) {
  retirement.cancel();
  generation++; controller?.abort(); controller = null;
  clearTimeout(deadline); clearTimeout(expiry); deadline = expiry = null;
  clearInput(); auth = null; busy = false;
  const previous = live; live = null;
  if (previous) {
    previous.channel.dispose();
    previous.rfb.dispose(); // Small pinned source patch provides deterministic teardown.
    retirement.retire(previous.channel.closed);
  }
  host.replaceChildren(); controls(false); message(text);
}
async function api(url, method, csrf, signal) {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {},
    body: method === 'POST' ? '{}' : undefined });
  if (!response.ok) throw new Error(response.status === 401 ? 'login' : 'request');
  return response.json();
}
async function connect() {
  if (!visible() || live || busy) return;
  if (retirement.request(() => { if (visible() && !manualPause) void connect(); })) {
    message('Waiting for the previous connection to close. No second viewer will be opened.');
    return;
  }
  busy = true; controls(false); message('Checking secure owner access…');
  const current = ++generation;
  controller = new AbortController(); const signal = controller.signal;
  deadline = setTimeout(() => { if (generation === current) dispose('Connection timed out. Reconnect when ready.'); }, 14000);
  try {
    const fresh = await api('/api/auth', 'GET', undefined, signal);
    if (generation !== current || !visible()) return;
    if (!fresh.authenticated) { dispose('Sign in to PocketTerminal, then open Desktop.'); return; }
    if (!fresh.desktop) { dispose('Desktop is not enabled on this server.'); return; }
    auth = fresh;
    await api('/api/desktop/start', 'POST', fresh.csrf, signal);
    if (generation !== current || !visible()) return;
    message('Connecting to your persistent desktop…');
    let rfb;
    const channel = new BoundedChannel(`${location.origin.replace('https:', 'wss:')}/api/desktop/socket`, fresh.csrf,
      () => { if (generation === current) dispose('Viewer resource limit reached. Reconnect when ready; apps keep running.'); },
      () => rfb?.queueStats.pending ?? false);
    try { rfb = new RFB(host, channel, { shared: true }); }
    catch { channel.dispose(); retirement.retire(channel.closed); throw new Error('viewer'); }
    live = { rfb, channel, generation: current };
    rfb.scaleViewport = fit; rfb.clipViewport = !fit; rfb.dragViewport = !fit;
    rfb.resizeSession = false; rfb.qualityLevel = 6; rfb.compressionLevel = 2; rfb.showDotCursor = true;
    rfb.addEventListener('connect', () => {
      if (generation !== current || !visible()) return;
      clearTimeout(deadline); deadline = null; busy = false; controls(true);
      message('Connected · unprivileged desktop · apps persist when you leave', true);
      expiry = setTimeout(() => { if (generation === current) dispose('Login expired. Sign in to PocketTerminal again.'); }, Math.max(0, fresh.expiresAt - Date.now()));
    });
    rfb.addEventListener('disconnect', () => { if (generation === current) dispose('Disconnected. Apps keep running. Reconnect to check access.'); });
    rfb.addEventListener('credentialsrequired', () => { if (generation === current) dispose('Private desktop configuration error. No extra password is required.'); });
  } catch {
    if (generation === current) dispose('Unable to connect. Check your login, then reconnect. Apps are not stopped.');
  }
}
function foreground() {
  if (!visible()) dispose('Viewer suspended. Your desktop apps keep running.');
  else if (!manualPause) void connect();
}
document.addEventListener('visibilitychange', foreground);
document.addEventListener('freeze', () => { frozen = true; foreground(); });
document.addEventListener('resume', () => { frozen = false; foreground(); });
window.addEventListener('pagehide', () => { frozen = true; foreground(); });
window.addEventListener('pageshow', () => { frozen = false; foreground(); });
$('back').addEventListener('click', () => dispose('Returning to terminals…'));
$('connect').addEventListener('click', () => { manualPause = false; void connect(); });
$('disconnect').addEventListener('click', () => { manualPause = true; dispose('Disconnected by you. Desktop apps keep running.'); });
$('fit').addEventListener('click', () => {
  fit = !fit; $('fit').setAttribute('aria-pressed', String(!fit)); $('fit').textContent = fit ? 'Fit screen' : '1:1 · drag to pan';
  if (live) { live.rfb.scaleViewport = fit; live.rfb.clipViewport = !fit; live.rfb.dragViewport = !fit; }
});
$('keyboard').addEventListener('click', () => { $('keyboard-panel').hidden = !$('keyboard-panel').hidden; if (!$('keyboard-panel').hidden) $('type-text').focus(); });
$('clipboard').addEventListener('click', () => { $('clipboard-panel').hidden = !$('clipboard-panel').hidden; if (!$('clipboard-panel').hidden) $('clipboard-text').focus(); });
function key(keysym) {
  if (!live || busy || !visible()) return;
  const rfb = live.rfb;
  try {
    if (ctrl) rfb.sendKey(0xffe3, 'ControlLeft', true);
    if (alt) rfb.sendKey(0xffe9, 'AltLeft', true);
    rfb.sendKey(keysym);
    if (alt) rfb.sendKey(0xffe9, 'AltLeft', false);
    if (ctrl) rfb.sendKey(0xffe3, 'ControlLeft', false);
  } catch { dispose('Input could not be confirmed. Reconnect; input will not be replayed.'); }
  ctrl = alt = false; $('ctrl').setAttribute('aria-pressed', 'false'); $('alt').setAttribute('aria-pressed', 'false');
}
$('ctrl').addEventListener('click', () => { ctrl = !ctrl; $('ctrl').setAttribute('aria-pressed', String(ctrl)); });
$('alt').addEventListener('click', () => { alt = !alt; $('alt').setAttribute('aria-pressed', String(alt)); });
document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => key(Number(button.dataset.key))));
$('type-send').addEventListener('click', () => {
  if (!live || busy || typeJob) return;
  const text = $('type-text').value;
  if ([...text].length > 128 || new TextEncoder().encode(text).length > 512) { message('Type at most 128 characters / 512 UTF-8 bytes at once.'); return; }
  $('type-text').value = '';
  typeJob = { chars: [...text], index: 0, generation, started: performance.now() };
  const step = () => {
    typeTimer = null;
    if (!typeJob || typeJob.generation !== generation || !live || !visible()) return clearInput();
    if (performance.now() - typeJob.started > 3500) { clearInput(); message('Typing stopped. Unsent input was discarded, not replayed.'); return; }
    const char = typeJob.chars[typeJob.index++];
    if (char === undefined) { typeJob = null; return; }
    const point = char.codePointAt(0);
    key(char === '\n' ? 0xff0d : char === '\t' ? 0xff09 : point <= 0xff ? point : 0x1000000 | point);
    if (typeJob) typeTimer = setTimeout(step, 20);
  };
  step();
});
$('clipboard-send').addEventListener('click', () => {
  if (!live || busy) return;
  const text = $('clipboard-text').value;
  if (/[^\x00-\xff]/.test(text) || new TextEncoder().encode(text).length > 4096) { message('Clipboard supports Latin-1 text up to 4 KiB. Use Keyboard for other characters.'); return; }
  $('clipboard-text').value = '';
  try { live.rfb.clipboardPasteFrom(text); message('Text sent to desktop clipboard. Paste inside the desktop manually.', true); }
  catch { dispose('Clipboard send failed. Input will not be replayed.'); }
});
$('logout').addEventListener('click', async () => {
  const csrf = auth?.csrf; manualPause = true; dispose('Signing out…');
  if (!csrf) { message('Use PocketTerminal to sign in or out.'); return; }
  try { await api('/api/logout', 'POST', csrf, AbortSignal.timeout(8000)); message('Signed out. Desktop apps keep running.'); }
  catch { message('Viewer detached; logout could not be confirmed. Check PocketTerminal.'); }
});
// Non-sensitive local diagnostics only: no framebuffer/input/auth objects exposed.
window.pocketDesktopStats = () => ({ renderers: live ? 1 : 0, busy, inputQueued: typeJob ? typeJob.chars.length - typeJob.index : 0,
  inputTimers: typeTimer ? 1 : 0, ...retirement.stats(), ...(live ? { queues: live.rfb.queueStats, channel: live.channel.stats() } : {}) });
controls(false);
if (location.protocol === 'http:') { const secure = new URL('/desktop/', location.href); secure.protocol = 'https:'; location.replace(secure.href); }
else if (location.protocol !== 'https:') throw new Error('HTTPS is required');
else void connect();
