# Using Limn — in-flow features

Behaviors that shape a review without being obvious from the buttons alone: which
untracked files are covered, which review opens when you reopen a repo, how a dirty
working tree is shown and approved, how the review panes are resized, and which agent
a new review starts with — plus the background service that serves it all, and the
one browser caveat.

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

Opening a **specific base/compare pair** (`limn --base <ref> [--branch <ref>]`)
**resumes the most-recently-touched live review** for that exact pair. Opening a
repo without refs — bare `limn`, or picking it on the Dashboard — lands on the repo
hub when it has live reviews, so you choose; only a repo with none opens a draft
review of the current branch. The *button* to start another review is discoverable;
the pair-resume rule ("which review opens for this pair?") is the invisible part.

Several live reviews can share one pair. In the repo hub (the **Sessions** button),
**New review** creates another live review **without archiving or overwriting** the
existing one. It is a split control: the button starts a fresh review on the current
branch; the caret opens a base ← compare picker. From a terminal, `limn --new` does the
same thing.

Older reviews stay listed in the hub (most-recently-touched first). Any of them can be
resumed, **archived** (a soft-delete — hidden from live lists and from the resume hint,
never destroyed), and later restored.

## Removing a repository from the list

The Dashboard lists every repo you have opened, plus every repo that still has a live
review. The **✕** on a row (it appears on hover) removes it from that list: its live
reviews are **archived**, and its last-opened stamp is cleared — the two things that
put it there. Nothing is deleted. Open the repo again and the row returns, with those
reviews waiting under **Show archived** in its hub.

## Reviewing a dirty working tree

When the working tree has uncommitted changes, the review shows the **merged
base → working-tree diff** — committed and uncommitted changes in one view. Per-line
left-edge **rails** distinguish where each line came from: committed (solid grey),
staged (solid amber), and unstaged (dotted amber). The diff header's **"?" marks key**
explains this legend in-app, so it is not repeated here.

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

## Sheets: what a diff shows beside current

A file's columns are a **stack of sheets**, pulled from the diff's left edge. The last
column is always **current** — the working tree, or the compare tip when there is no
worktree. The sheets a file can have, oldest first:

| Sheet | Resolves to | Answers |
| --- | --- | --- |
| **base · main** | the base ref | what this branch changes |
| **agent review** | the commit the review was generated at | what the narration never saw |
| **approval** | your latest approval | what landed after you signed off |
| **file view** | that file's own view mark | what moved since you last read it |

They are tracked independently, so they can disagree: approve, then regenerate the
review, and the review checkpoint is *newer* than the approval. Each is offered under
its own name. A file only offers the sheets it actually has.

**Unified** — no sheet out — keeps one caption, *main · current*: what the diff is
measured against, then what it shows. The first name is a picker (*Full diff*, *Since
agent review*, *Since approval*, *Since file view*), so the baseline is always visible
and changeable. The left-edge drift rail stays single: one amber hatch meaning "this
moved since your latest checkpoint" — your approval if you made one, otherwise the
commit the review was generated at.

**Pulling a sheet.** A thin tab runs down the diff's left edge, quiet until the file is
hovered. Each click pulls one more sheet: first whatever the diff was measured against,
then the base, then any other checkpoint. One sheet out is **Split** — that sheet beside
current, changes paired row by row, its caption still a picker. From two sheets on the
view is **Multi**: the base is fixed first, every other column is a checkpoint, and each
column is diffed against the base so every row lines up on a base line. Two marks
attribute the differences: an amber **since** rail on a current line the checkpoint
beside it never had, and a grey **gone** rail on a checkpoint line current no longer
has. Beyond three columns each gets a 180px floor and the body scrolls sideways. The
checkpoint columns take no comments — comments anchor on the base or the tree, as they
always have.

**Putting one back.** Once a sheet is out a **−** sits above the tab, level with the
captions; it puts the last-pulled sheet back. Hovering a column shows an **×** that
closes just that sheet. Closing the last checkpoint folds it under: Unified is then
measured against it.

**Every file, or this one.** Every file shows the review's default stack until you change
its own. When a file differs from the rest, a **✓** and a **↺** jump out of the card's
left edge beside the strip. The ✓ makes every file follow — that stack becomes the
review's default, remembered with the review. The ↺ goes the other way: it puts just
this file back on the default. A file that matches the rest shows neither. `[` pulls a sheet on the
file nearest the top of the screen, `]` puts one back; hold ⇧ with either (or ⇧-click the
tab or −) to apply the change to every file at once.

In every layout the in-place editor opens in the current column only; in Split and Multi
the other columns keep showing their lines beside it.

## Unchanged lines

The runs of unchanged lines between changes are folded, the way GitHub folds them.
A short run (20 lines or fewer) opens whole with one click; a longer one offers two
steps — ▲ shows 20 more lines above the change below it, ▼ shows 20 more below the
change above it — until 20 or fewer remain. **Expand all** in a file's header opens every
run; it reads **Collapse** once anything is open. Folds open in every baseline and in a
read-only review: the text is read from the tree (or the compare tip), not from the
editing capability. Walking the ↑/↓ keys or growing the editor across a fold opens it
the same 20 lines at a time.

## The marks key

The **?** at the right end of each file's caption row opens a compact key for everything
that file's diff draws, and only that: the colours (added, removed, and the word-level
highlight inside an edited line) always; the left-edge rails (staged / unstaged /
changed-since) when the file has uncommitted lines or the review has a checkpoint to
drift from; the between-sheets marks (**since** / **gone**) while a checkpoint sheet is
out beside the base. Each group says when it applies.

## Resizing the sidebar and chat drawer

Drag the divider next to the sidebar or the chat drawer to resize it (arrow keys
work when it is focused; double-click resets). Widths are remembered.

On a window too narrow to hold both panes at their remembered widths, they are squeezed
so the diff keeps a usable width and the drawer stays on screen. The widths you chose are
not overwritten — widen the window and they come back.

## Default agent

Every new review starts from a default review agent — an engine (Claude or Codex),
optionally a model, and, for models that support it, a reasoning effort. Changing
the agent picker inside an open review changes that review only; it doesn't touch
the default.

Set the default from **Settings → Agents → Default review agent**, or from the CLI:

```bash
limn config                                # show the current default
limn config get agent|model|effort         # print one value
limn config set agent|model|effort <value> # change it
```

Setting `agent` to a different engine clears model and effort for the old one; if
there was a model or effort set to clear, it prints `note: model and effort reset
to auto (not available for <engine>)`. Setting
`model` to one that doesn't support the current effort clears it instead, with
`note: effort reset to auto (not available for <model>)`. `set model auto` clears any
model and effort. An invalid value — an unknown engine, model, or effort, or an
effort with no model set — is rejected without changing anything, e.g. `limn: unknown
effort "ultra" for gpt-5.5 (low, medium, high, xhigh)`, printed to stderr with exit
code 1.

`limn config` talks to the running service over the same connection the app uses;
if none is running, it reads and writes the SQLite database file directly.

## Actions

An action pins agent work to a button. There are two kinds: a **skill** the agent
already has installed (`/simplify`, `/security-review`, a Codex `$skill`) and a
**prompt** in your own words ("Rebase this branch onto main and resolve conflicts").
Limn never installs or ships skills; it only asks each engine what it has.

Pin actions from **Settings → Actions**. A skill action takes the bare skill name
(`simplify`, `pr-review-toolkit:review-pr`); the editor offers the names Limn has
seen on any engine. A prompt action takes the text verbatim. Actions are global and
listed in the order you drag them into.

Run one from the **bolt** beside the chat selector in the chat drawer (it is there
before the first thread too). A click runs the action at once on a new thread with
your default agent, execution mode auto. The `›` at a row's edge opens a second
pane: another engine or model, or an existing thread to run inside. A skill row
shows a mark per engine when two engines are installed — solid when the engine's
last session reported the skill, struck when it did not, pulsing while a check is
open — and a row your default agent cannot run opens the pane at the reason, with
Refresh.

Each action runs in its own thread, one turn per run ("Simplify · run 2"). The run
bar under the drawer head says what is running, and Cancel lives there. Limn
appends one paragraph to the prompt telling the agent about the `add_finding`
tool; nothing else is added. A skill run checks the skill against the session's
own command list before the prompt goes out and refuses, with the engine's words,
when it is missing.

Findings land on the code as **proposed** comments: a dashed box with a
`proposed` pill and the severity the agent assigned, a dashed ring in the gutter,
and their own count in the header (`3 comments · 4 proposed`). Proposals never
count as unresolved and never enter your batch on their own. Each one offers
**Accept** (it becomes a queued comment for the agent's next batch), **Keep** (an
agent note you handle yourself), **Dismiss** (hidden, restorable) and **Reply**
(stays proposed). With a proposal's box focused, `a`, `k`, `d` and `r` do the
same. A strip above the diff steps through the newest run's proposals and carries
Accept all / Dismiss all. Re-running an action replaces the proposals you have not
touched; accepted, kept or replied-to ones stay. The hotspots a review generation
finds are proposals too, from the review run.

Every agent task on a repository — a generation, an action run, a chat turn, a
batch — takes one lane, in the order it was asked for. A task behind a busy repo
waits and says so (`Queued · 2nd, behind Generating the review`). The **Chat**
button's pill reports everything running with the drawer closed: `N running · M
queued`, amber when an approval waits on you, dashed `N proposed` when a run
finished with results you have not looked at; hover it for the list.

## Review loop from your agent

`limn --generate` opens a review and starts generation immediately, instead of
waiting for a click: on a pair with no session it runs a full pass, on one with a
live session it runs an update pass, and `--new` forces a fresh session first. Add
`--print-url` to print the review's page URL on stdout — nothing else — so a script
or an embedded browser (an editor pane, a coding agent's own browser tool) can pick
it up without a terminal window opening a browser.

The recipe this is built for is a Claude Code Stop hook that opens the review the
moment the agent finishes its turn:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "limn --generate --print-url" }] }] } }
```

This starts generation on the service and prints the review's URL; open the printed
link (or your service's dashboard) to watch it. The hook needs the service installed
(`limn service install`) first: a Stop hook runs non-interactively, with no terminal
to answer the "install as a background service?" prompt or to Ctrl-C a foreground
server, so `--generate`/`--print-url` with no service running fails fast instead of
hanging — `limn: no Limn service is running — run \`limn service install\``, exit 1.

`--agent`, `--model` and `--effort` override the default review agent (see [Default
agent](#default-agent)) for this generation only — they need `--generate`, and
`--effort` needs a model (its own or one already set), e.g. `limn --generate --effort
high` with no model configured fails with `limn: reasoning effort needs a model (set
a model first)`.

If a review is already generating for the same repository when you run `--generate`
again, Limn does not start a second pass — it answers with the review that's already
running and a stderr note: `note: a review is already generating for this repository
— opening this review`. Opening that URL in a browser tab that wasn't there when
generation started still shows it live: the tab adopts the running pass and streams
its output, and a second tab on the same URL does the same. `--new` on a busy repo
does not mint a fresh session either — the note adds `(--new ignored while a pass is
running)` so it's not silently dropped.

Inside a [cmux](https://github.com/get-cmux/cmux) session (`CMUX_SOCKET` set, `cmux`
on `PATH`), a plain `limn --generate` (no `--print-url`) opens the review in a
browser pane beside the agent's own rather than a system browser window. If the pane
fails to open, Limn falls back to the system browser and prints `note: cmux pane
failed (<reason>) — opened in the browser`. `--print-url` wins over cmux — it always
just prints the URL.

## The service

Limn is a local Node server plus a browser tab. The first `limn` offers to install that
server as a background service so `http://limn.localhost:5466` is always there; you can
do it later — or repair it — with `limn service install`.

```bash
limn service install [--port-80]  # write + load the unit, start it, wait for /health
limn service status               # activation, URL, pid, node path, native commands
limn service logs [-f]            # the service log
limn service uninstall            # unload + delete the unit; the database is untouched (run this BEFORE npm uninstall -g)
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

**Uninstalling.** Remove the service *before* the package:

```bash
limn service uninstall
npm uninstall -g @glebmish/limn
```

The unit is `KeepAlive` (launchd) / `Restart=always` (systemd), so removing the package
first leaves it respawning a node that can no longer find its entry script — a crash
loop, logged every couple of seconds, until you unload it by hand. The database is not
touched by either step.

**What the loopback perimeter is, and is not.** On the default bind there is no token:
any process running under any account on this machine can reach `127.0.0.1:5466` and do
everything you can do through the UI — read the repos you have opened, run the agent
with your credentials. That is the trust model, and it is the same one `git`, your SSH
agent and the engine CLIs already assume. What the guard does buy you is that a *web
page* cannot: `/rpc/*` and `/events` reject a cross-site or opaque `Origin`, reject a
non-loopback `Host` (DNS rebinding), and require `Content-Type: application/json`,
which an HTML form cannot send.

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

`LIMN_WEB_HOST` / `LIMN_WEB_TOKEN` also steer the CLI itself: as long as they are set in
the shell you run it from, `limn service install`, `limn service status` and bare `limn`
probe *that* address (not `127.0.0.1`), `status` prints the real URL, and `limn` sends
the token with `cli:open` and appends it to the page URL it opens. To check by hand:

```bash
curl -X POST -H 'Authorization: Bearer <the token>' -H 'Content-Type: application/json' \
  -d '[]' http://<tailnet-ip>:5466/rpc/dashboard
```

(`Content-Type: application/json` is required — `/rpc/*` answers 415 without it.)

## Safari

Safari does not resolve `*.localhost`, so `http://limn.localhost:5466` fails there. Use
`http://127.0.0.1:5466` instead — same server, same reviews, still a secure context.

`limn` from a terminal always opens the `limn.localhost` URL; if Safari is your default
browser, copy the address and swap the host for `127.0.0.1`.
