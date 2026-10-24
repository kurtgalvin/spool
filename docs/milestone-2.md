# Milestone 2 — Attention and housekeeping

Make Spool tell you when a session needs you, and make sessions easy to manage.
Builds on [milestone 1](milestone-1.md); see [design.md](design.md) for the overall design.

## Steps

1. **Needs-input notifications** — badge on the Spool activity bar icon with the count of
   sessions needing input; a toast with a **Show** button when a session moves to
   **needs input**, skipped if you're already looking at that terminal.
2. **Rename, kill, mark idle** — context-menu actions on a session. Rename updates the
   sidebar and the terminal tab; kill closes the terminal; **Mark Idle** manually fixes a
   status left stale by an interrupt; **Remove from List** clears exited sessions.
3. **Auto-name** — name a session from its first prompt (truncated) unless it has been
   renamed by hand. Along the way: `/clear` now exits the old entry and starts a new one in
   the same terminal, and exited sessions can be **resumed** (`claude --resume`) from the
   sidebar.
4. **Reload behavior + persistence** — find out what happens to Spool terminals on window
   reload (VS Code may revive them, but the IPC socket path changes with the extension
   host). Persist session metadata (name, Claude session id, cwd) in workspace state and
   reconnect revived terminals where possible.

## Out of scope

Groups, side threads, resume-after-reload actions, OS-level notifications when VS Code
isn't focused.

## Done when

- A session hitting a permission prompt shows a badge on the Spool icon and a toast;
  **Show** focuses its terminal.
- Sessions can be renamed and killed from the sidebar.
- New sessions get a name from their first prompt.
- After **Developer: Reload Window**, sessions are still listed with their names, and
  revived terminals keep reporting status (or the limitation is documented).

## Open questions

- Should a toast also fire for sessions in other VS Code windows? (Currently each window
  only knows its own sessions.)
- Can the extension rename a terminal tab that isn't active? (The built-in rename command
  only targets the active terminal.)
