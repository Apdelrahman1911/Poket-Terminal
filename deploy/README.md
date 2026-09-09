# Ordinary Linux deployment examples

Follow the ordered [root README](../README.md). These files do not provision a
provider workspace or mutate an existing host automatically.

- `pocketterminal.service`: root foreground Python supervisor, private environment
  file, loopback Node. **KillMode=process**, no fallback group kill and no private
  `/tmp` namespace: independent owner tmux jobs must survive a web restart.
- `Caddyfile`: replace the placeholder domain with the exact `PT_ORIGIN` host;
  preserves Host/Origin and handles TLS redirects/WebSocket upgrades. No public
  Node/desktop listener or permissive CORS.

HUP reloads Node using the supervisor's existing environment. Changing the env
file requires a controlled **supervisor restart**, not just HUP. Persistent
Desktop opt-in is read by each new Node process and can therefore use HUP when
there is no overriding `PT_DESKTOP_ENABLED` variable.

The scoped deployment test runs the actual foreground supervisor with synthetic
state and verifies the same tmux pane survives HUP, child crash, stop and relaunch.
It does not launch systemd/Caddy or claim public DNS/TLS/phone acceptance. Validate
those on the destination host before valuable work. Reboot ends RAM processes.
