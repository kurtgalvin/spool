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

## Architecture

```
┌──────────────── VS Code extension ────────────────┐
│  Session tree view  ◄──  Session store  ◄── IPC server (local socket)
│        │                     ▲                         ▲
│        ▼                     │                         │
│  createTerminal(env: SPOOL_ID, cmd: claude --settings …)│
└────────────────────────────────────────────────────────┘
                     │                                    │
                     ▼                                    │
              claude (in terminal) ── hook fires ──► spool-hook script
                                     (stdin JSON)    (sends SPOOL_ID + payload)
```

### Launching a session

1. Extension generates a `SPOOL_ID` and creates an integrated terminal with
   `SPOOL_ID` (and the IPC socket path) in its environment.
2. Terminal runs `claude --settings <path-to-spool-hooks.json>` (plus
   `--resume <id> --fork-session` for side threads).
3. The terminal ↔ `SPOOL_ID` mapping is kept in the session store.

### Hooks → status

Each hook runs a small script that reads the hook's JSON payload from stdin and sends
it, tagged with `SPOOL_ID`, to the extension's local socket.

| Hook | Effect |
| --- | --- |
| `SessionStart` | Record/update Claude `session_id` (fires again on `/clear` and resume). |
| `UserPromptSubmit` | Status → **working** |
| `Notification` | `permission_prompt` / `elicitation_dialog` → **needs input**; show badge/toast. `idle_prompt` → **idle** (recovers from interrupts, see below). |
| `PostToolUse` | **needs input** → **working** (the only signal that a permission prompt was approved) |
| `Stop` | Status → **idle** |
| `SessionEnd` | Status → **exited** |

Terminal close events (`onDidCloseTerminal`) are a fallback for marking sessions exited.

**Known gap — interrupts:** cancelling a turn (Esc) fires no hook and writes no marker to
the transcript (checked on Claude Code 2.1.310), so the session stays **working** until the
next event. `idle_prompt` is mapped to **idle**, but testing showed it is *not* sent after an
interrupt, so it doesn't fix this. Ideas for later:

- A manual "Mark idle" action on a session.
- Watch the transcript file and treat a long stretch with no new entries as idle.
- Re-check newer Claude Code versions for an interrupt hook or transcript marker.

### Data model (sketch)

```ts
interface Session {
  spoolId: string;
  claudeSessionId?: string;   // from SessionStart; changes on /clear
  name: string;
  status: 'starting' | 'working' | 'needs-input' | 'idle' | 'exited';
  parentId?: string;          // set for side threads
  groupId?: string;
  cwd: string;
  terminal?: vscode.Terminal;
}

interface Group {
  id: string;
  name: string;
}
```

Groups, names, and parent links are persisted in workspace state so the structure
survives reloads, even though the terminals themselves do not.

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
- tmux backing for sessions that survive VS Code reloads.
- Session history browser from `~/.claude/projects/` transcripts.
- Marketplace release.

## Open questions

- **Groups:** purely visual in v1, or also group actions (close all, broadcast prompt, combined status)?
- **Side-thread nesting:** full tree, or one level deep?
- **Scope:** show only the current workspace's sessions, or sessions across all windows?
- **Comment routing (v2):** which session receives a comment — picker, last-focused, or pinned per file/worktree?
- **Comment delivery (v2):** send each comment immediately, or batch as a review?
- **Getting results back:** what form should a "result" take — transcript excerpt, summary, diff?
- **Naming:** auto-name sessions from the first prompt? (`UserPromptSubmit` carries `prompt`.)
  The transcript also stores a generated title (`{"type": "ai-title", "aiTitle": "..."}`),
  which would make nicer names, but it's an undocumented internal format and could change.
- **IPC transport:** Unix socket vs. localhost HTTP (Windows support matters for Marketplace).
