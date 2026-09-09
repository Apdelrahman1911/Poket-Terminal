# Publication implementation status

**READY_FOR_PUBLICATION_REVIEW — source-only local commit; no push or deployment.**

- Portable exact HTTPS origin, configurable confined projects, safe SSH hints and private owner Codex defaults implemented.
- Telegram pins both numeric bot ID and exact username against private pairing state; missing/legacy/mismatched pins fail closed. Command suffixes use the same configured pin. No env-only identity switch or stale input replay.
- Desktop child NPROC512 counts Linux threads, reserves no RAM and changes no Chrome/renderer/network sandbox, site isolation or web security. Corresponds to original native fix `a418514d36af53bc87a827d8763e8138a122f0fc`.
- Fresh Ubuntu24.04 x86_64 README, private env/password/bot setup, job-preserving systemd/Caddy examples, desktop activation, operations/upgrade/rollback/backup and licensing notes complete.
- Provider payloads/baselines/private builder files removed. Application code has no newly assigned permissive license; noVNC MPL source/patch/licenses retained.
- Builds pass. Scoped config/security/pairing/deployment/fake-RFB suite: **34/34**. Final bot-suffix parser check after scan fix: **1/1**, followed by a fresh root typecheck/build. Fake-client lifecycle: **5/5** (10,000 stuck-close cycles). AST-only native-limit check: **1/1**.
- Initial CLI-fixture failure was corrected by filtering undefined env entries before node-pty stringification; focused CLI and scoped suite reruns pass. No unresolved test failures. Vite's existing >500kB chunk warning remains non-fatal.
- No new browser/native GUI/Chrome/model/real Telegram/soak test, package install, service restart or live edit. Historical memory is explicitly labeled; actual CDP freeze followed emulated visibility/disposal, and aggregate renderer RAM includes three processes/spares, not phone RAM.
- Systemd/Caddy/DNS and physical-device deployment acceptance are pending the destination operator; coordinator handles final privacy/provenance review and push.
- Final commit/tree, export delta, exact evidence, source scan, local frozen artifacts and remaining steps: ignored `.runtime/PUBLICATION_HANDOFF.json`.
