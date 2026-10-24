# Spool — Design

Spool is a VS Code extension for managing multiple Claude Code terminal sessions.

## Problem

Running several Claude Code sessions at once is hard to juggle: it's not obvious which
session is working, which is waiting on you, and how sessions relate to each other.

## Goals

- See every Claude Code session at a glance, with live status.
- Get notified when a session needs input.
- Organize sessions into groups.
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
  left by a crash (nothing answering) is removed. Clients reconnect, restarting the broker
  if needed, whenever the connection drops.
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
| `SessionStart` | Record/update Claude `session_id` (fires again on `/clear` and resume). |
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
  groupId?: string;
  cwd?: string;
  terminal?: vscode.Terminal;
  shellPid?: number;          // the only terminal identifier that survives a reload
}

interface Group {
  id: string;
  name: string;
}
```

### Persistence and reloads

On **Reload Window**, terminals survive with the same shell pid and `claude` still running,
but `creationOptions.env` comes back empty, so `SPOOL_ID` isn't visible to the extension.
Each session is saved (minus the terminal) to `globalStorage/sessions/<id>.json`. On
startup — and when workspace folders change — a window loads:

- sessions whose `shellPid` matches one of its terminals (re-attached, last known status);
- exited sessions whose `cwd` is inside one of its workspace folders (resumable);

and skips sessions whose shell is still alive elsewhere (running in another window).

## v1 scope

- **Session sidebar** (tree view): list sessions, click to focus terminal, rename, kill.
- **New session** command.
- **Live status** icons from hooks.
- **Notifications** when a session needs input (badge on the view + toast).
- **Groups**: user-created folders; move sessions between them.
- **Side threads**: "Branch side thread" on a session forks it; the fork is shown nested
  under its parent.

## Roadmap

### v2

- **Inline code comments** via the VS Code Comments API: highlight code, comment, send to
  a session. Likely a "review mode" that batches comments across files and submits them
  as one prompt with file paths, line ranges, and selected code.
- **Replies in threads**: on `Stop`, post the hook payload's `last_assistant_message`
  back into the comment thread (no transcript parsing needed).
- **Resume group** after reload: relaunch every session in a group with `--resume`.

### Later

- Mute notifications per session (or per group), so busy sessions don't keep toasting.
- Side threads reporting results back to their parent (reusing the reply mechanism).
- Worktree-per-session for isolated parallel work.
- tmux backing for sessions that survive quitting VS Code (reloads are already handled).
- Session history browser from `~/.claude/projects/` transcripts.
- Marketplace release.

## Open questions

- **Groups:** purely visual in v1, or also group actions (close all, broadcast prompt, combined status)?
- **Side-thread nesting:** full tree, or one level deep?
- **Scope:** each window shows its own running sessions plus exited ones for its open
  folders. Should it also show other windows' running sessions (read-only, can't focus)?
  The broker would make a shared view possible.
- **Comment routing (v2):** which session receives a comment — picker, last-focused, or pinned per file/worktree?
- **Comment delivery (v2):** send each comment immediately, or batch as a review?
- **Getting results back:** what form should a "result" take — transcript excerpt, summary, diff?
- **Naming:** auto-name sessions from the first prompt? (`UserPromptSubmit` carries `prompt`.)
  The transcript also stores a generated title (`{"type": "ai-title", "aiTitle": "..."}`),
  which would make nicer names, but it's an undocumented internal format and could change.
- **Windows support:** the broker uses a Unix socket path; Windows would need a named
  pipe (`\\.\pipe\spool-…`), which Node's `net` supports with the same API.
- **Exited-session cleanup:** session files accumulate; prune old exited ones?
