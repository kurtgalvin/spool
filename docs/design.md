# Spool — Design

Spool is a VS Code extension for managing multiple Claude Code terminal sessions.

## Problem

Running several Claude Code sessions at once is hard to juggle: it's not obvious which
session is working, which is waiting on you, and how sessions relate to each other.

## Goals

- See every Claude Code session at a glance, with live status.
- Get notified when a session needs input.
- Organize sessions by the folder (repo) they run in.
- Branch a "side thread" off an existing session without disturbing it.

Primary user is me (personal tool), but design choices should not block a future
Marketplace release — e.g. never modify the user's global Claude Code config.

## Key decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where sessions run | VS Code integrated terminals | Native feel, no extra dependencies. tmux can come later if persistence matters. |
| How we learn session state | Claude Code hooks | Structured, reliable events vs. fragile terminal scraping. |
| How hooks are installed | Per-launch via `claude --settings <spool-hooks.json>` | Hooks only apply to Spool-launched sessions; global `~/.claude/settings.json` is untouched. |
| Side threads | `claude --resume <id> --fork-session` | Native fork: new session with the parent's full history, parent unaffected. |
| Hook transport | One per-user socket owned by a background **broker** process | Hooks need one stable address regardless of which window or workspace launched the session; only one process can listen on a socket, and windows reload. |
| Sidebar organization | Group by folder: nearest git repo root, else the start folder | Matches how work is split across repos; a parent folder of several repos gets its own group. No setup. |
| Persistence | One JSON file per session in global storage | Survives reloads and workspace identity changes (adding a folder to a window); windows only write their own sessions. |

## Architecture

```
 window A (extension host)          window B (extension host)
 tree view ◄─ session store          tree view ◄─ session store
                 ▲   BrokerClient                    ▲   BrokerClient
                 │   (subscribe, ping every 2s)      │
                 └────────────┐        ┌─────────────┘
                              │        │
                     broker (detached; one per user)
                     $TMPDIR/spool-<uid>-v1.sock
                              ▲
                              │ one line per hook
 claude (terminal) ─ hook ─► spool-hook script (SPOOL_ID + payload)
```

### Broker

- The first window that needs it spawns `out/broker.js` detached (using the extension
  host's own executable with `ELECTRON_RUN_AS_NODE`), so it outlives reloads.
- Hook scripts connect, send one message, and close. Windows send `subscribe`, then `ping`
  every 2s, and receive every hook message; each window ignores terminals it doesn't own.
- Exits after 60s without a ping from any window (long enough to survive a reload).
- Replays the last minute of messages to a new subscriber, so hooks fired mid-reload
  aren't lost.
- If two windows race to start it, the loser sees a live broker and exits; a socket file
  left by a crash (nothing answering) is removed. Each broker remembers the inode of the
  socket file it created and exits (without unlinking) if the path stops being its file —
  which happens when brokers starting at once against a stale file remove each other's.
- Clients reconnect whenever the connection drops, waiting 2s for another window's broker
  before starting their own.
- **Updates:** a window sends its extension version on `subscribe`; the broker replies
  `hello` with its own. A newer window sends `shutdown` and starts the replacement right
  away (the other windows' 2s wait lets it win), so updates apply without closing windows.
  An older window leaves a newer broker alone. **Spool: Restart Broker** does the same on
  demand (useful in development, where the version doesn't change). Hooks fired during the
  swap (well under a second) are lost.
- The socket path carries a protocol version; bump it on incompatible changes.

### Launching a session

1. Extension generates a `SPOOL_ID` and creates an integrated terminal with
   `SPOOL_ID` (and the broker socket path) in its environment.
2. Terminal runs `claude --settings <path-to-spool-hooks.json>` (plus
   `--resume <id> --fork-session` for side threads).
3. The terminal ↔ `SPOOL_ID` mapping is kept in the session store.

### Hooks → status

Each hook runs a small script that reads the hook's JSON payload from stdin and sends
it, tagged with `SPOOL_ID`, to the broker, which forwards it to every window.

| Hook | Effect |
| --- | --- |
| `SessionStart` | Record/update Claude `session_id` (fires again on `/clear` and resume; a fork's has `source: "fork"` and the new id). |
| `UserPromptSubmit` | Status → **working** |
| `Notification` | `permission_prompt` / `elicitation_dialog` → **needs input**; show badge/toast. `idle_prompt` → **idle** (recovers from interrupts, see below). |
| `PermissionRequest` | **needs input** (fires immediately; `Notification` follows ~3s later) |
| `PostToolUse` | **needs input** → **working** (the only signal that a permission prompt was approved) |
| `Stop` | Status → **idle** |
| `SessionEnd` | Status → **exited** |

Terminal close events (`onDidCloseTerminal`) are a fallback for marking sessions exited.

**Known gap — interrupts:** cancelling a turn (Esc) fires no hook and writes no marker to
the transcript (checked on Claude Code 2.1.310), so the session stays **working** until the
next event. Rejecting a permission prompt (**No**) is also an interrupt: no hook fires
(probed `PermissionDenied`, `PostToolUseFailure`, `StopFailure` — none arrive), so the
session stays **needs input**. That case *does* write `[Request interrupted by user for
tool use]` to the transcript, so watching the transcript could catch it. `idle_prompt` is mapped to **idle**, but testing showed it is *not* sent after an
interrupt, so it doesn't fix this. Ideas for later:

- A manual "Mark idle" action on a session.
- Watch the transcript file and treat a long stretch with no new entries as idle.
- Re-check newer Claude Code versions for an interrupt hook or transcript marker.

### Data model (sketch)

A Spool session is one Claude conversation, not one terminal. `/clear` ends the current
session (it shows **exited**) and starts a new one in the same terminal; `/resume` of a
session still in the list re-attaches that entry. Hooks are routed by `SPOOL_ID` (which
terminal) plus `session_id` (which conversation).

```ts
interface Session {
  id: string;
  terminalId: string;         // the terminal's SPOOL_ID
  claudeSessionId?: string;   // from SessionStart
  name: string;
  nameSource: 'default' | 'auto' | 'user';
  status: 'starting' | 'working' | 'needs-input' | 'idle' | 'exited';
  parentId?: string;          // set for side threads
  cwd?: string;
  launchDir?: string;         // where the terminal started; decides the folder group
  terminal?: vscode.Terminal;
  shellPid?: number;          // the only terminal identifier that survives a reload
}

interface FolderGroup {       // derived, not stored
  dir: string;                // nearest git root of launchDir, else launchDir
  isRepo: boolean;
}
```

### Persistence and reloads

On **Reload Window**, terminals survive with the same shell pid and `claude` still running,
but `creationOptions.env` comes back empty, so `SPOOL_ID` isn't visible to the extension.
Each session is saved (minus the terminal) to `globalStorage/sessions/<id>.json` by the
window running it, on every change. Every window syncs from those files on startup, when
a file changes (directory watch), when a terminal opens, when workspace folders change,
and every 5s (to notice windows that closed without updating their files). Sessions
running in the window itself are skipped — it's their source of truth. Other files become:

- **re-attached**, if `shellPid` matches one of the window's terminals (last known status);
- **running elsewhere**, if the shell is still alive (or has no pid yet): shown read-only
  with the other window's live status, never written back;
- **exited**, if the launch folder is inside one of the window's workspace folders
  (resumable); otherwise hidden.

Sessions whose file disappears (removed in another window) are dropped.

## v1 scope

- **Session sidebar** (tree view): list sessions, click to focus terminal, rename, kill.
- **New session** command.
- **Live status** icons from hooks.
- **Notifications** when a session needs input (badge on the view + toast).
- **Folder groups**: sessions grouped by repo (or start folder), each with a **+** to
  start a session there. (Replaces the original plan of user-created groups.)
- **Side threads**: "Branch side thread" on a session forks it; the fork is shown nested
  under its parent.

## Roadmap

Near-term fixes and smaller features are tracked in [backlog.md](backlog.md).

### v2

- **Inline code comments** ([milestone 4](milestone-4.md)): comment on code in any file,
  queue comments on a session or ask in a read-only side thread; Claude reads them and
  replies per thread through a Spool MCP server. A comments view shows threads as leaves
  under their files.
- **Session history** ([milestone 5](milestone-5.md)): a History view of the folder's
  Claude conversations that Spool isn't showing, from `~/.claude/projects/` transcripts,
  to resume or branch into Spool.
- **Resume group** after reload: relaunch every session in a group with `--resume`.

### Later

- Mute notifications per session (or per group), so busy sessions don't keep toasting.
- Side threads reporting results back to their parent (reusing the reply mechanism).
- Worktree-per-session for isolated parallel work.
- tmux backing for sessions that survive quitting VS Code (reloads are already handled).
- Marketplace release.

## Open questions

- **Groups:** folder groups are automatic. Add named groups later? Group actions (close
  all, broadcast prompt)?
- **Side-thread nesting:** full tree, or one level deep?
- **Scope:** each window shows every running session (other windows' read-only) plus
  exited ones for its open folders. Should exited sessions from other folders show too?
- **Getting results back:** what form should a "result" take — transcript excerpt, summary, diff?
- **Naming:** auto-name sessions from the first prompt? (`UserPromptSubmit` carries `prompt`.)
  The transcript also stores a generated title (`{"type": "ai-title", "aiTitle": "..."}`),
  which would make nicer names, but it's an undocumented internal format and could change.
- **Windows support:** the broker uses a Unix socket path; Windows would need a named
  pipe (`\\.\pipe\spool-…`), which Node's `net` supports with the same API.
- **Exited-session cleanup:** session files accumulate; prune old exited ones?
