# Changelog

## 0.4.0

Limn is now an npm-installable package instead of a desktop app, shipped as a tarball on
the GitHub Release (not the npm registry):
`npm i -g https://github.com/glebmish/limn/releases/latest/download/limn.tgz`, then `limn` in a
repository.

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
  `LIMN_DEV_HOOKS=1`. Service unit files are written `0600`. The reviewed repository is
  treated as untrusted input: Claude sessions load only your own `~/.claude` settings,
  skills and `CLAUDE.md` (`settingSources: ['user']`), never the repository's
  `.claude/` settings, skills, commands, `.mcp.json` or `CLAUDE.md`; a turn whose
  permission mode Limn can't set fails before any prompt instead of running in the
  adapter's default; generation turns deny every command and file edit the engine asks
  about; remote images in agent- or branch-authored markdown render as inert text. The
  package ships no server source maps.
- **Packaging.** Pure-JS package (≈ 7 MB tarball / ≈ 49 MB installed) with the ACP
  adapters bundled and no platform binaries; Node `^22.13 || >=23.4`. Not published to the
  npm registry: CI attaches the checked tarball (`glebmish-limn-<version>.tgz`, a
  stable-named `limn.tgz`, and `SHA256SUMS`) to the GitHub Release, and npm installs it
  from the release URL.
- **Database.** 0.4.0 keeps using the desktop app's database file and migrates it in
  place to schema v8 the first time it opens it. Don't run 0.1–0.3 against it afterwards:
  there is no down-migration, and older builds can't load the migrated sessions.
- **Removed.** The Electron app, its `limn` shell shim (the CLI offers to delete an old
  one), and the desktop notifications.
- **Codex sandbox per tier.** Codex review generation, and chat or action turns that
  can't edit the branch, run in a read-only sandbox with network off; so does
  **Ask for approval**, where each edit waits for you. **Accept edits** lets Codex edit
  the workspace and asks you before anything outside it or any network access.

Also new since 0.3:

- **Actions.** Pin a skill or a prompt, run it from the bolt in the chat drawer, and
  triage its findings as proposed comments (Accept, Keep, Dismiss).
- **Merge from the review.** A merge sheet with preflight gates, fast-forward / squash /
  merge strategies, and an agent rebase turn for conflicts.
- **In-place edits.** Fix a line yourself in the diff, without leaving the review.
- **Diff sheets.** Split and Multi layouts that put the base, the review checkpoint,
  your approval or your last file view beside the current code.
- **Scoped updates.** A small drift updates only the affected sections instead of
  re-narrating the branch.
- **Sturdier comment anchors.** Comments are stamped when created and re-anchored by
  diff mapping and fuzzy context, so they survive rebases and reformatting.
- **One queue per repository.** Agent tasks wait their turn and say what they are
  waiting for, instead of being refused.
- **ACP engines.** Claude and Codex both run through the Agent Client Protocol, via
  pinned adapters bundled with the package.
- **CLI.** `limn --generate` and `--print-url` for a review loop driven from your agent,
  and `limn config` for the default review agent.

Earlier versions (0.1–0.3) were the desktop app; their notes are on the
[GitHub releases page](https://github.com/glebmish/limn/releases).
