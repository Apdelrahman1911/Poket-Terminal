# noVNC provenance and minimal patch

Selected exact npm `@novnc/novnc@1.7.0` (maintained core) over Ubuntu's older
noVNC 1.3.0. Only Raw/CopyRect/Tight client code is bundled. No noVNC application
server, websockify daemon, WebCodecs/H.264, React or xterm is loaded in `/desktop/`.
`esbuild@0.28.2` and transitive packages are locked in `package-lock.json` with
registry URLs/integrities. Ubuntu packages come from signed configured Ubuntu
repositories only when the operator explicitly provisions packages. No installation transcript/private state is included in this publication.

`scripts/build.mjs` copies the upstream npm package, verifies all eight modified
files against `upstream-sha256.json`, then applies `novnc-1.7.0.patch` with
`--fuzz=0`. A mismatch fails the isolated build; upstream is never edited in
node_modules. Rebase/retest explicitly on a future noVNC update.

| Patched file | Reason |
|---|---|
| `core/websock.js` | Replace upstream 40 MiB growth ceiling with explicit 4 MiB receive/64 KiB send guards, small initial receive and deterministic storage disposal |
| `core/display.js` | 128-action/8 MiB render budget including UTF-16 data-URL cost; geometry checks; image queue/two-canvas disposal |
| `core/inflator.js` | Refuse inflated output >4 MiB before allocation |
| `core/rfb.js` | Public idempotent `dispose()`/queue stats; bounded clipboard/geometry; only required decoders/encodings |
| `core/input/keyboard.js` | Cancel pending keyboard timer on ungrab |
| `core/util/browser.js` | Do not run unused H.264 capability probe |
| `core/util/cursor.js` | Remove cursor listeners/timers deterministically |
| `core/util/events.js` | Dispose mouse capture observer and pending capture work |

The application calls public lifecycle methods, not a fragile enumeration of
upstream private fields. Focused tests also exercise actual patched classes at
receive/render/inflate/send limits and verify double disposal. A separate
10,000-cycle fake-stuck-close test checks the application connection gate.

Upstream MPL-2.0 notices remain intact; modifications to these source files are
MPL-2.0. Each isolated build includes the complete **patched corresponding
noVNC source**, original patch/hash list, `AUTHORS`, noVNC licenses and bundled
vendor licenses in its `source/` tree and client license file. `client/LICENSES.txt` is mounted through the same authenticated
static allowlist. Keep the complete corresponding source with any redistribution
and provide it to recipients; do not ship just the minified bundle without the
required license/source availability.
