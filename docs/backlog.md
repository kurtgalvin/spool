# Backlog

Fixes and features found in the review after milestone 3 (2026-10-24), roughly in the order
we'd tackle them. See [design.md](design.md) for the overall design and roadmap.

## Hardening

- **Move the tests into the repo.** The store, broker, groups, status, and naming tests
  only exist in a scratch directory so far. Add them under `test/` with `npm test`. The
  broker tests are timing-sensitive; they caught a real race, so keep the repeated runs.
- **Ghost sessions after a reboot.** A session running in another window is detected by
  its shell pid being alive. After a reboot pids are reused, so a stale "working" file can
  match an unrelated process and show as **other window** forever, with no actions to
  remove it. Fix: also save the shell's start time and compare it (or have windows report
  their live sessions to the broker), and offer **Remove** on such rows.
- **Clear exited sessions.** Session files are never deleted, and every window reads all
  of them every 5s. Add **Clear Exited** on a group, and maybe prune exited sessions older
  than N days.
- **Duplicate toasts after reload.** The broker replays the last minute of hooks to a
  reloaded window, so a permission prompt already answered can toast again. (The final
  status is right.) Skip toasts for replayed events.
- **Hooks need `node` on PATH.** The hook command is `node "$SPOOL_HOOK_SCRIPT"`; with the
  native Claude installer and no Node, every hook fails silently. Blocker for the
  Marketplace. Options: run the hook with VS Code's executable (`ELECTRON_RUN_AS_NODE`,
  slower to start), or a tiny shell/compiled sender.

## Features

- **Last reply preview.** `Stop` carries `last_assistant_message`; show a snippet in the
  tooltip (or under the name) so you can see what a session said without opening it.
- **Next session needing input.** A command (with a keybinding) that cycles through
  sessions waiting on you.
- **Mute** notifications per session or group.
- **Interrupt detection** from the transcript: rejecting a permission prompt writes
  `[Request interrupted by user for tool use]`; a long quiet stretch could cover Esc.
- **Session history:** resume any past conversation for a folder from
  `~/.claude/projects`, not only ones Spool launched.
- **OS notifications** when VS Code isn't focused.
- **Duplicate group names:** disambiguate two repos with the same folder name in the label.
- **Home-folder trust prompt:** with no folder open, sessions start in `~`, where Claude
  never saves trust, so the prompt reappears every launch. Ask for a folder instead (or a
  `spool.defaultFolder` setting).

- **Read-only sessions** (deferred from [milestone 4](milestone-4.md)). A `PreToolUse`
  hook on `Edit|Write|MultiEdit|NotebookEdit|Bash` denies the tool when the session is
  read-only, with a reason Claude sees ("Read only: answer instead of editing"). Read-only
  is a flag file per `SPOOL_ID` in global storage, checked locally by the hook, so it can be
  toggled on any running session. Bash is denied completely, since shell commands can write
  files. Caveat: hooks fail open, so with no `node` on PATH read-only silently does nothing;
  warn on sessions whose hooks never fired.

## Later / Marketplace

- Windows support (named pipe instead of a Unix socket).
- Repository URL, icon, and README for publishing.
