# Using Limn — in-flow features

Three behaviors that shape a review without being obvious from the buttons alone:
which untracked files are covered, which review opens when you reopen a repo, and how
a dirty working tree is shown and approved.

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
