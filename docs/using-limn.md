# Using Limn — in-flow features

Behaviors that shape a review without being obvious from the buttons alone: which
untracked files are covered, which review opens when you reopen a repo, and how a dirty
working tree is shown and approved — plus the background service that serves it all, and
the one browser caveat.

> **Audience:** reviewers using the app. This is the how-it-behaves companion to the
> README "Using it" section — for the architecture behind these features see
> [storage-layer.md](storage-layer.md) and [agent-layer.md](agent-layer.md).

## Excluding untracked files

Only **untracked** working-tree files (files git does not track yet) can be excluded
from a review. Tracked and committed files are always part of the diff and can never be
excluded.

**The default is automatic and invisible.** Once you generate a guided review, an
untracked file that the agent placed in **no section** (an "orphan") is auto-excluded —
it drops out of the main diff so the narrated review stays focused. Before generation,
in a flat (not-yet-narrated) review, nothing is auto-excluded; every untracked file is
shown. So an untracked file can appear to vanish after generation — that is this rule,
not a bug.

Excluded files collect in a compact, collapsed **Untracked** group below the main diff.
Each row expands in place to peek its diff and has an **Include** (`+`) button
("Include in the review") that lifts the file back into the diff above. An *included*
untracked file shows an **×** in its file header ("Exclude — back to Untracked") to send
it back down.

Excluded files carry **no review state**: no Viewed checkbox, no section membership, and
the Untracked group's open/closed state intentionally resets on every load. Your
include/exclude choices, however, **persist per review** — an explicit Include overrides
the auto-exclusion default, and the first exclude toggle on a draft review is what mints
the saved session.

## Multiple reviews per branch

Opening a repo — or a specific base/compare pair — **resumes the most-recently-touched
live review** for that exact pair. The *button* to start another is discoverable; the
resume rule ("which review opens when I open this repo?") is the invisible part.

Several live reviews can share one pair. In the repo hub (the **Sessions** button),
**New review** creates another live review **without archiving or overwriting** the
existing one. It is a split control: the button starts a fresh review on the current
branch; the caret opens a base ← compare picker. From a terminal, `limn --new` does the
same thing.

Older reviews stay listed in the hub (most-recently-touched first). Any of them can be
resumed, **archived** (a soft-delete — hidden from live lists and from the resume hint,
never destroyed), and later restored.

## Reviewing a dirty working tree

When the working tree has uncommitted changes, the review shows the **merged
base → working-tree diff** — committed and uncommitted changes in one view. Per-line
left-edge **rails** distinguish where each line came from: committed (solid grey),
staged (solid amber), and unstaged (dotted amber). The diff header's **"i" markers key**
explains this legend in-app whenever the tree is dirty, so it is not repeated here.

Two titlebar affordances track uncommitted work. The **drift pill** (shown when the
branch moved while you were reading) distinguishes, on hover, new commits from
uncommitted edits (a pencil chip), alongside the combined ±delta; clicking it reloads.
The **commit timeline** adds a pencil to its HEAD stop when the loaded tree is dirty, and
that stop's tooltip shows the uncommitted ±counts.

**Approval is per surface.** A dirty tree is a different approved surface than the commit
underneath it. Approve a clean commit and then edit files, and the approve control reads
**"Committed changes approved"** with a **"new uncommitted changes"** nudge until you
approve the dirty surface too.

One limit worth stating: the agent **cannot apply comments to a dirty tree**. Sending
queued comments requires a clean working tree on the checked-out compare branch; if that
precondition is unmet, the agent run reports that edits are unavailable rather than
silently answering read-only.

## The service

Limn is a local Node server plus a browser tab. The first `limn` offers to install that
server as a background service so `http://limn.localhost:5466` is always there; you can
do it later — or repair it — with `limn service install`.

```bash
limn service install [--port-80]  # write + load the unit, start it, wait for /health
limn service status               # activation, URL, pid, node path, native commands
limn service logs [-f]            # the service log
limn service uninstall            # unload + delete the unit; the database is untouched
limn service serve [--port N] [--port-80]   # no service at all: a foreground server, Ctrl-C to stop
```

On macOS the unit is a LaunchAgent at `~/Library/LaunchAgents/dev.glebmish.limn.plist`
(`RunAtLoad` + `KeepAlive`, log at `~/Library/Logs/limn.log`). On Linux it is a
`systemd --user` unit at `~/.config/systemd/user/limn.service` (`Restart=always`); run
`loginctl enable-linger $USER` if you want it up without a login session. On Linux the
unit appends stdout/stderr to the same log file `status` prints, while `limn service
logs` reads the journal (`journalctl --user -u limn`) — check both if one looks empty. Install is idempotent — re-run it after Node moves and it repairs the recorded
path. Windows is not supported for the background service yet; `limn service serve`
works there.

`limn service status` is the one command to reach for when something is off:

```
Limn 0.4.0
  activation:  launchd agent dev.glebmish.limn — loaded, RunAtLoad+KeepAlive, running
  server:      http://limn.localhost:5466  (127.0.0.1:5466)  pid 4211  up 3d 2h
  node:        /opt/homebrew/bin/node — matches unit
  database:    /Users/you/Library/Application Support/limn/limn.db
  logs:        /Users/you/Library/Logs/limn.log
  restart:     launchctl kickstart -k gui/501/dev.glebmish.limn
  stop:        launchctl bootout gui/501/dev.glebmish.limn   (or: limn service uninstall)
```

It exits 0 only when the server answers **on loopback** and — for an installed unit —
the `node` the unit records still exists. Activation is exactly one of **service** (a unit is loaded),
**foreground** (something answers `/health` but no unit is loaded, e.g. `npx`), or **not
running**.

**Upgrading.** `npm i -g @glebmish/limn@latest` swaps the files under the path the unit
records, but the running process keeps the old code until you restart it:

```bash
npm i -g @glebmish/limn@latest
launchctl kickstart -k gui/$UID/dev.glebmish.limn   # macOS
systemctl --user restart limn                        # Linux
```

There are deliberately no `limn service stop` / `restart` subcommands — `status` prints
the native ones above for your platform.

**`--port-80`.** `limn service install --port-80` binds a second listener on
`127.0.0.1:80` when that port is free, so the port-less `http://limn.localhost` works
too. It is opt-in because squatting port 80 would collide with the next thing you run
there; if the bind fails it is logged and ignored, and 5466 stays canonical either way.

**Reaching Limn from another device (Tailscale).** The server refuses to bind anything
but loopback without a token, so set both when you install:

```bash
LIMN_WEB_HOST=<tailnet-ip> LIMN_WEB_TOKEN=$(openssl rand -hex 16) limn service install
```

`install` records `LIMN_PORT`, `LIMN_DB`, `LIMN_WEB_HOST` and `LIMN_WEB_TOKEN` from the
shell that ran it into the unit, so the service comes back with the same binding after a
reboot. Then open `http://<tailnet-ip>:5466/?token=<the token>` on the other device — the
tab stores the token in `sessionStorage`, so reloads stay authenticated. Anyone who can
reach that address and holds the token can read this machine's repos and use its agent
credentials, so keep it to a private tailnet.

> **Known limitation.** With a non-loopback `LIMN_WEB_HOST` the server binds *only* that
> address, but `limn service install` and `limn service status` still probe
> `127.0.0.1`. So install reports `service installed but not answering on 5466 after
> 10s` and `status` reports `— not answering` (exit 1) even when the service is up and
> healthy. Verify it yourself instead — open the URL above, or:
>
> ```bash
> curl -X POST -H 'Authorization: Bearer <the token>' -d '[]' \
>   http://<tailnet-ip>:5466/rpc/dashboard
> ```

## Safari

Safari does not resolve `*.localhost`, so `http://limn.localhost:5466` fails there. Use
`http://127.0.0.1:5466` instead — same server, same reviews, still a secure context.

`limn` from a terminal always opens the `limn.localhost` URL; if Safari is your default
browser, copy the address and swap the host for `127.0.0.1`.
