# Milestone 3 — Organization

Organize the sidebar around where sessions run, across every window, and branch side
threads off a session. Builds on [milestone 2](milestone-2.md); see [design.md](design.md)
for the overall design.

## Steps

1. **Folder groups** — sessions are grouped by the folder they were started in: the
   nearest enclosing git repo root, or the start folder itself when it isn't inside a
   repo. Starting a session in a parent folder that holds several repos gives that parent
   its own group, next to the repos' groups. Each group has a **+** that starts a session
   in its folder; every open workspace folder has a group even with no sessions. A
   collapsed group shows counts of sessions needing input or working. Sessions started in
   a repo's subfolder show the subfolder next to their status.
2. **Sessions from every window** — show running sessions from other VS Code windows under
   their folders, with live status, marked **other window** (their terminal can't be
   focused from here, and they have no actions). Windows already save every change to their
   session files, so other windows mirror those files (watching the sessions directory)
   instead of interpreting hooks for terminals they don't own. A 5s check catches windows
   that closed without updating their files; their sessions show as exited.
3. **Side threads** — **Branch Side Thread** (branch icon, or right-click) on any session
   with a conversation, running or exited, runs `claude --resume <id> --fork-session` in a
   new terminal in the parent's folder. The thread is nested under its parent and
   auto-named from its first prompt; the parent keeps running untouched. Checked on Claude
   Code 2.1.310: the fork's `SessionStart` has `source: "fork"` and the new session id. If
   the parent is removed, its threads move up to the group's top level. `/clear` in a
   thread's terminal starts a new top-level session.

## Out of scope

Named groups you create yourself (folders may cover most of what they were for; revisit
after using this), group actions (close all, broadcast a prompt), threads reporting back to
their parent.

## Done when

- Sessions appear under their repo's group, and a session started in a parent folder
  appears under that folder's own group.
- **+** on a group starts a session in that folder.
- A session running in another window shows under its folder with live status.
- A side thread can be branched from a session and appears nested under it.

## Open questions

- Should exited sessions for folders that aren't open anywhere be shown, or pruned after
  a while?
- Two groups with the same folder name (e.g. two `api` repos): disambiguate in the label?
  (The tooltip shows the full path.)
