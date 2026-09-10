// One page-level view controller. Fullscreen never replaces the RFB renderer,
// reconnects the socket, or changes the server's fixed framebuffer dimensions.
export function installFullscreen(root, button) {
  const doc = root.ownerDocument;
  let wanted = false, requesting = false, exiting = false, disposed = false, mode = 'none';
  const ownsNative = () => doc.fullscreenElement === root;
  function render(next) {
    mode = next;
    if (next === 'none') delete root.dataset.desktopFullscreen;
    else root.dataset.desktopFullscreen = next;
    button.setAttribute('aria-pressed', String(next !== 'none'));
    button.textContent = next === 'native' ? 'Exit full screen' : next === 'page' ? 'Exit expanded view' : 'Full screen';
    button.title = next === 'page' ? 'Expanded page: browser fullscreen is unavailable. Escape or this button exits.' : 'Full screen desktop. Escape or this button exits.';
  }
  function exitNative() {
    if (exiting || !ownsNative() || typeof doc.exitFullscreen !== 'function') return;
    exiting = true;
    const settled = () => {
      exiting = false;
      // A refused native exit must not leave the visible exit control lying.
      if (!disposed && ownsNative()) { wanted = true; render('native'); }
    };
    try { Promise.resolve(doc.exitFullscreen()).then(settled, settled); }
    catch { settled(); }
  }
  function leave() { wanted = false; render('none'); exitNative(); }
  function changed() {
    if (disposed) return;
    if (ownsNative()) {
      if (wanted) render('native');
      else exitNative();
    } else if (mode === 'native') { wanted = false; render('none'); }
  }
  function toggle() {
    if (disposed) return;
    if (wanted || ownsNative()) { leave(); return; }
    wanted = true; render('page');
    // Keep at most one pending request, even during rapid tapping/backgrounding.
    // iPhone and denied-fullscreen browsers still get a compact, expanded view.
    if (requesting || exiting || doc.fullscreenElement || doc.fullscreenEnabled === false || typeof root.requestFullscreen !== 'function') return;
    requesting = true;
    const failed = () => { requesting = false; if (!disposed && wanted) render('page'); };
    try {
      Promise.resolve(root.requestFullscreen()).then(() => {
        requesting = false;
        if (disposed || !wanted) exitNative();
        else if (ownsNative()) render('native');
      }, failed);
    } catch { failed(); }
  }
  function escape(event) {
    if (event.key !== 'Escape' || (!wanted && !ownsNative())) return;
    event.preventDefault(); event.stopImmediatePropagation(); leave();
  }
  button.addEventListener('click', toggle);
  doc.addEventListener('fullscreenchange', changed);
  doc.addEventListener('keydown', escape, true);
  render('none');
  return {
    reset: leave,
    dispose() {
      if (disposed) return;
      disposed = true; leave();
      button.removeEventListener('click', toggle);
      doc.removeEventListener('fullscreenchange', changed);
      doc.removeEventListener('keydown', escape, true);
    },
    stats: () => ({ mode, pending: requesting || exiting, listeners: disposed ? 0 : 3 }),
  };
}
