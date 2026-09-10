# PocketDesktop (optional)

One private, persistent 1280×720 XFCE desktop, served by PocketTerminal's existing
HTTPS authentication at `/desktop/`. No public VNC/X11/websockify service. The
locked non-root GUI account has no sudo or access to root's keys/projects.
Terminal/Codex sessions remain independent of this desktop and its viewers.

- [Fresh-host setup, activation, upgrade and rollback](DEPLOYMENT.md)
- [Daily owner steps](OWNER_STEPS.md)
- [Security and explicit queue/resource limits](SECURITY_AND_BOUNDS.md)
- [Test scope and historical four-minute memory observation](TEST_RESULTS.md)
- [Pinned noVNC MPL patch/provenance](patches/README.md)

From the parent installation root:

```bash
npm --prefix desktop ci
npm --prefix desktop run build
npm --prefix desktop test
npm --prefix desktop run test:limits
```

Builds only `desktop/.runtime/candidates/client/`; it refuses outputs outside its
own `.runtime` and refuses to overwrite a `FROZEN.json` candidate. No build starts
a GUI or installs packages/services. Provisioning is a separate explicit root
operator command. No browser, heavyweight desktop browser or GUI is installed
by `npm ci`/build. Source-only limit tests invoke no native service.

## Fullscreen and administrator access

Use **Full screen** in the desktop toolbar. Where the browser supports the
Fullscreen API, this enters browser fullscreen; otherwise **expanded view**
hides the page header/help/footer while retaining an always-reachable exit button.
Press **Escape** or the exit button to return. Other controls scroll horizontally
on a narrow screen. Use the toolbar's **Esc** key to send Escape to a desktop app.
Fullscreen scales the same fixed 1280×720 desktop; it does not start another
renderer, connection, native process, or a larger framebuffer.

**Permission denied in `/root` is intentional.** The GUI/browser account is
unprivileged and cannot read root credentials or root-owned projects. Open
**Terminals**, create/select a **Shell**, and run `cd /root` for administrator
commands; that shell already runs as root. Normal desktop files belong in the
desktop user's Home folder. Do not make `/root` public, grant the GUI passwordless
sudo, or run Chrome as root to work around the separation. Sharing a specific
project directory requires a separate explicit, scoped operator decision.

Lightweight fullscreen tests: `npm --prefix desktop test` and, from the repository
root, `npm run test:desktop-ui`. The browser tests use a synthetic in-memory RFB
peer, not a real VPS desktop or owner login. Run them as a normal non-root user
with sandboxed Playwright Chromium (`npx playwright install chromium --only-shell`).
They check native fullscreen, mobile expanded-view fallback, fixed framebuffer
dimensions, one socket/renderer across toggles, and cached-page reconnection.
Physical-phone fullscreen/browser-chrome behavior still depends on the browser.
