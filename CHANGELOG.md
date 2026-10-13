# Changelog

## 0.4.0

Limn is now an npm package instead of a desktop app: `npm i -g @glebmish/limn`, then
`limn` in a repository.

- **Local service + browser UI.** `limn` starts (or reuses) a local server and opens the
  review at `http://limn.localhost:5466` in your default browser. `limn service install`
  keeps it running in the background (launchd on macOS, `systemd --user` on Linux);
  `status`, `logs`, `uninstall` and a foreground `serve` round out the CLI.
- **`limn open` from any repository.** `limn [DIR] [--base REF] [--branch BRANCH] [--new]
  [--hub]` hands the review to the running service through a one-time ticket and opens a
  tab on it.
- **Remote access.** `LIMN_WEB_HOST` + `LIMN_WEB_TOKEN` bind a Tailscale (or other
  non-loopback) address behind bearer-token auth; a non-loopback bind without a token
  refuses to start.
- **Security hardening.** `/rpc/*` and `/events` reject cross-site, opaque-Origin and
  userinfo/non-loopback `Host` requests, require `application/json`, cap request bodies
  at 8 MB, and honour `?dev=` screenshot hooks only when the server runs with
  `LIMN_DEV_HOOKS=1`. Service unit files are written `0600`.
- **Packaging.** Pure-JS package (≈ 5 MB tarball / ≈ 35 MB installed) with the ACP
  adapters bundled and no platform binaries; Node ≥ 22.13. Releases are published from
  CI with npm provenance.
- **Removed.** The Electron app, its `limn` shell shim (the CLI offers to delete an old
  one), and the desktop notifications.

Earlier versions (0.1–0.3) were the desktop app; their notes are on the
[GitHub releases page](https://github.com/glebmish/limn/releases).
