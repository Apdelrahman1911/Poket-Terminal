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
