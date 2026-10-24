# Milestone 1 — Session pipe

**Status: ✅ done (2026-10-24).** Known gap: interrupted turns stay **working** (see
[design.md](design.md#hooks--status)).

The thinnest end-to-end slice: launch a Claude Code session from Spool and watch its
status change live in a sidebar. Everything else in v1 builds on this pipe.
See [design.md](design.md) for the overall design.

## Steps

1. **Scaffold** — TypeScript VS Code extension with build, lint, and an F5 debug launch config.
2. **IPC server** — on activation, listen on a local Unix socket; expose its path to
   terminals via an env var.
3. **Hook script + settings** — ship `spool-hooks.json` registering `SessionStart`,
   `UserPromptSubmit`, `Notification`, `Stop`, and `SessionEnd`, plus a small Node script
   that reads hook JSON from stdin and sends it to the socket tagged with `SPOOL_ID`.
4. **"Spool: New Session" command** — create an integrated terminal with `SPOOL_ID` in its
   env and run `claude --settings <spool-hooks.json>`.
5. **Session store** — update status and `claudeSessionId` from hook events; mark exited
   on terminal close.
6. **Sidebar tree view** — list sessions (name, status icon, description); click to focus
   the terminal.

## Out of scope

Groups, side threads, notifications, rename/kill, persistence across reloads, Windows support.

## Done when

- Running "Spool: New Session" twice shows two entries in the sidebar.
- Typing a prompt flips that entry to **working**; it returns to **idle** when Claude
  finishes; a permission prompt shows **needs input**.
- Closing a terminal marks its session **exited**.
- The global `~/.claude/settings.json` is untouched.

## Assumptions to validate

- ✅ `--settings` loads hooks from a file path outside the project.
- ✅ Hook processes inherit the terminal's environment, so `SPOOL_ID` reaches the hook script.
- ✅ `SessionStart` provides the Claude `session_id` (needed later to fork side threads);
  every later event carries the same id.
- ⏳ `Notification` fires on a permission prompt (needs an interactive session — step 4).

Validated in step 3 by running `claude -p` with `--settings resources/spool-hooks.json`
(Claude Code 2.1.310): `SessionStart` → `UserPromptSubmit` → `Stop` → `SessionEnd` all
arrived over the socket.

## Next milestones

- **M2** — notifications, rename/kill, persisting session metadata.
- **M3** — groups and side threads. M2 + M3 complete v1.
