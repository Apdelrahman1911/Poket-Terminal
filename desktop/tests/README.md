# Test tiers

Publication-only, no native GUI/browser/model/network service dependency:

```bash
# In a disposable combined checkout, after both isolated builds:
npm run test:publication
npm --prefix desktop test
npm --prefix desktop run test:limits
```

These need Node24, tmux, Python3, OpenSSL and Linux `/proc`; the fake Unix socket
and root-owned opt-in boundary tests require root. State and tmux filesystem
sockets stay under the disposable checkout's ignored `.runtime`. Fixtures use
synthetic password/token/bot IDs and loopback fake Telegram/RFB only.

Separate **operator opt-ins**, not publication gates: native `test:service`,
Playwright configs, `novnc-bounds.mjs` and the memory/browser scripts require
explicit private desktop provisioning and a sandbox-capable test host. They can
start/stop the **dedicated test** GUI and must never target owner apps. The browser
launcher requires the locked `pocketdesktop-browser` account and an operator-
installed Chrome for Testing executable at `/opt/pocketdesktop-testing/chromium/chrome`
(root-owned, readable/executable by that account, appropriate sandbox support).
It drops UID before exec and refuses sandbox-disabling flags. No automatic browser
install, OS install or sandbox workaround is provided; do not run these while
someone is debugging/using live desktop services. The historical run's sandboxed
Chrome/native evidence is not a fresh publication test result.
