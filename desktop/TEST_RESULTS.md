# Test scope and historical memory observation

## This portable publication

Isolated source builds and focused config/Host/Origin/CSRF/auth/pairing/compiled
TTY CLI/supervisor-persistence/fake-RFB tests are recorded in the ignored
publication handoff. Fake-client unit tests include **10,000 stuck-close cycles**;
AST-only Python checks assert NPROC512/NOFILE1024/CORE0 without importing the
native supervisor or making resource-limit syscalls.

**No new browser, native GUI, Chrome, real Telegram, model or memory-soak test**
was run for the portable export/512-limit change. The systemd/Caddy examples were
not launched here. The destination operator must verify systemd/DNS/TLS and real
device/optional integration behavior. No source/build artifact here was deployed
or pushed by the implementation CLI.

## Historical original implementation (Ubuntu 24.04 x86_64)

The original candidate had focused actual-patched-noVNC, native private-service,
auth/gateway/O_PATH-canary, real keyboard/mouse/manual-clipboard and browser
lifecycle checks. Those were isolated synthetic GUI identities, not owner apps.
The full logs/state/screenshots are deliberately **not in source Git**. These are
historical observations, not fresh claims about this export.

### Real 237.743-second changing-screen run

A real TigerVNC/XFCE synthetic 1280×720 screen changed **2,772 times** (about 12 fps,
15 fps cap) with one real noVNC viewer at emulated 390×844. A second authenticated
Raw-RFB reader paused its transport and stopped ACKs; native reads paused and it
was detached after the 5 s ACK deadline (observed over 6.529 s). The normal viewer
survived. Ten hide/return cycles, steady/reconnected phases and warm detached
phases used the **same backend PID and synthetic GUI identities** throughout,
without forced GC/restart/limit resets. Cleanup reported zero viewer/upstream/
canvas/input/close-waiter resources; browser test UID had zero remaining processes.

| Historical measurement | MiB |
|---|---:|
| Private desktop: all 11 processes RSS / PSS | 298.78 / 119.55 |
| Node baseline RSS | 90.06 |
| Node one-viewer RSS / delta | 105.91 / +15.85 |
| Node peak RSS | 106.95 |
| Browser one-viewer JS heap used | 8.13 |
| **Total renderer RSS / PSS: 3 renderer processes incl. spares** | **407.75 / 172.22** |
| Peak aggregate renderer RSS | 428.29 |
| Warm final vs first detached Node RSS delta | −0.65 |
| Warm JS heap / aggregate renderer RSS delta | −2.05 / −3.15 |

One noVNC renderer is not the same as three Chromium renderer **processes**.
8.13 MiB is JS heap, **not total browser RAM or phone RAM**. Total browser and
renderer processes were measured separately. RSS counts shared pages repeatedly;
PSS apportions them. Owner jobs and the test driver were separate. These short
observations are not a workspace RAM guarantee, arbitrary-browser-site budget or
all-day leak acceptance. NPROC512 reserves no RAM and was not rebenchmarked here.

### Emulated visibility versus actual CDP freeze

Sandboxed non-root Chrome for Testing 153 was used. This headless build did not
emit DOM visibility/freeze notifications for `Page.setWebLifecycleState(frozen)`.
The test **emulated hidden visibility, awaited disposal, then actually froze and
unfroze via CDP, then emulated visible**. Thus a real CDP freeze occurred, but not
an independent test of phone OS-delivered events or freezing an attached viewer.
The no-ACK slow reader separately covers a client that ceases consuming bytes.

Historical preservation reporting recorded a **pre-existing missing baseline
pane; cause not independently established; never recreated**. Directory mtime
drift was consistent with active owner work, not proof of its cause; it was not
"repaired". No owner-specific PIDs, workspace inventories or private baseline
artifacts are included in this portable source export.
