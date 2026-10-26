# Backlog

Fixes and features found in the review after milestone 3 (2026-10-24), roughly in the order
we'd tackle them. See [design.md](design.md) for the overall design and roadmap, and
[ideas.md](ideas.md) for bigger, less settled directions.

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

## Features

- **Last reply preview.** `Stop` carries `last_assistant_message`; show a snippet in the
  tooltip (or under the name) so you can see what a session said without opening it.
- **Next session needing input.** A command (with a keybinding) that cycles through
  sessions waiting on you.
- **Mute** notifications per session or group.
- **Interrupt detection** from the transcript: rejecting a permission prompt writes
  `[Request interrupted by user for tool use]`; a long quiet stretch could cover Esc.
- **OS notifications** when VS Code isn't focused.
- **Duplicate group names:** disambiguate two repos with the same folder name in the label.
- **Remote Control button.** An action on a running session's row that turns on Claude
  Code's remote control, by typing `/remote-control` into it the way comment prompts are
  typed (one line, Enter sent separately). Show which sessions have it on: Claude's process
  registry (`~/.claude/sessions/<pid>.json`) has a `bridgeSessionId` while it's connected,
  so the row could get an icon or "remote" in its description. Check how the command
  behaves when it's already on, and whether it needs the user to confirm anything.
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

## Other agents

- **Put Claude Code behind an agent interface**, so other CLI agents can be added later.
  Today Claude-specific code is spread through the extension:
  - launching: the `claude` command and its flags (`--settings`, `--mcp-config`,
    `--resume`, `--fork-session`), and the settings and MCP config files in `resources/`;
  - status: hook event names and payloads, and how they map to statuses (`status.ts`), plus
    the hook script and settings that install the hooks;
  - session identity: `session_id` from SessionStart, how `/clear` and `/resume` show up;
  - typing into the TUI: the 150ms gap before Enter so it isn't taken as a paste;
  - history: transcript paths and line formats, and the process registry (`history.ts`);
  - naming from prompts, and what the MCP instructions assume.

  An `Agent` interface would cover those: how to launch, resume and fork; how to install
  its hooks and turn their events into statuses; how to submit a line; where its history
  lives and how to read it; which capabilities it has (forking, MCP, remote control), so
  the UI hides what an agent can't do. Claude Code becomes the first implementation.
  Spool's own parts (sessions, groups, the broker, comments, the MCP server's tools) stay
  agent-neutral. Worth doing before a second agent, not before: the interface should come
  from what two agents actually need.

## Walkthroughs

Ideas from Microsoft's CodeTour extension, which plays back hand-written tours using the
same Comments API threads and Previous / Next (see [milestone 6](milestone-6.md)). CodeTour's
details are from memory; check its docs and `.tour` schema before building.

- **Export to CodeTour.** Save a walkthrough as `.tours/<title>.tour` in the repo, so a good
  explanation becomes onboarding docs anyone with CodeTour can play, without Spool. The
  format is JSON with a file, line and markdown description per step. Most valuable of
  these: it turns a one-off answer into something the team keeps.
- **Steps that follow the code.** CodeTour can anchor a step to a text pattern instead of a
  line, and record the commit a tour was written against to warn when code changed. Ours
  could re-anchor a step when the changed-since check finds its code moved (an open
  question in milestone 6), and show "changed since" on a stale step.
- **Steps without code.** A text-only step (an intro or summary) or a step on a folder, so
  Claude can open with the big picture before step 1. Needs a home in the editor, since a
  comment thread needs a file and line: maybe the walkthrough's first file, or a webview.

## Later / Marketplace

- Windows support (named pipe instead of a Unix socket).
- An icon (PNG) and a Marketplace and Open VSX listing. Releases on GitHub are done
  ([milestone 7](milestone-7.md)).
