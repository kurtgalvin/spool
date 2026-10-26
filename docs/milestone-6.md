# Milestone 6 — Claude's comments and walkthroughs

Give Claude more to work with in comment threads, and let it write comments of its own:
single notes on code, and walkthroughs, ordered steps across files that explain something
and that you step through with Previous / Next. Builds on [milestone 4](milestone-4.md)'s
comments and MCP server; see [design.md](design.md) for the overall design.

## Tools

Spool's MCP server (`mcp__spool__*`) ends up with:

| Tool | Does |
|---|---|
| `read_comments(status?, file?, start_line?, end_line?)` | Comments on this session, with their threads (was `get_comments`) |
| `reply_to_comment(comment_id, text)` | Claude's reply in a thread (was `reply`) |
| `add_comment(file, start_line, end_line, text)` | A new thread started by Claude |
| `add_walkthrough(title, steps)` | A new walkthrough; each step is `{file, start_line, end_line, text}` |
| `add_steps(walkthrough_id, after_step?, steps)` | Inserts steps after a step, or at the end |
| `edit_comment(comment_id, text)` | Rewrites Claude's own text on a comment or step |
| `remove_steps(walkthrough_id, step_ids)` | Removes steps |
| `update_walkthrough(walkthrough_id, title?, order?)` | Renames or reorders a walkthrough |

Lines are 1-based in every tool, as Claude sees them in files; Spool stores them 0-based.
Paths can be absolute or relative to the session's working directory. Every tool only sees
and changes this session's comments and walkthroughs.

## Steps

1. **Renamed tools, filters, and changed-since.**
   - `get_comments` becomes `read_comments`, `reply` becomes `reply_to_comment`. The prompt
     Spool types and the server's instructions use the new names. Sessions already running
     keep the old server until they restart.
   - Filters, all optional:
     - `status`: `waiting` (default: sent or read, no reply yet), `replied` (answered,
       waiting on you), `resolved`, or `all`.
     - `file`: only comments on that file. `start_line` / `end_line` (need `file`): only
       comments whose range overlaps.
   - Only the default read marks comments **read**; a filtered read changes nothing. Queued
     comments and drafts are never returned. `replied`, `resolved` and `all` return the
     newest 20 and say how many more there are.
   - Each comment is checked against the file on disk, comparing lines with indentation
     trimmed, and says one of:
     - **unchanged**;
     - **moved to lines X–Y**: the snapshot is elsewhere in the file;
     - **changed since**: the snapshot isn't in the file anymore; the current lines are
       included next to it;
     - **file not found**: deleted or renamed.

     The line filter matches the moved position when there is one. Nothing is written back:
     the stored range stays as it was.
   - The instructions say: call `read_comments` without filters when told about new
     comments; use filters for background on a file, and don't answer resolved threads.

2. **Claude's comments.** `add_comment` starts a thread on code, attached to the session that
   made it, so your reply goes back to it.
   - A comment records who started it (`author: 'claude'`). Its first comment shows Claude as
     the author in the editor; `read_comments` labels it `Claude:`.
   - It starts as **replied**: waiting on you, so it counts in the Comments badge and in the
     session's replied count, and **Next Reply** visits it.
   - It's marked **new** in the sidebar until you open it.
   - `edit_comment` rewrites the first comment if Claude wrote it (never your text, never
     replies). The editor shows "edited" next to Claude's name.
   - The instructions say: comment when asked to (a review, "point out…"), or to flag
     something you need to look at; never on every edit.

3. **Walkthroughs.** `add_walkthrough(title, steps)` creates ordered steps across files.
   - **Data:** each step is a comment with `walkthroughId`. The walkthrough is its own record,
     saved as a file next to comments:

     ```
     Walkthrough { id, sessionId, title, steps: [commentId, …], createdAt }
     ```

     The order lives only on the walkthrough, so inserting, removing or reordering changes
     one list, and "Step 3/7" is worked out from it.
   - **Editor:** a step's thread is labeled **Step 3/5 · How hooks reach the sidebar**. Its
     title bar has **‹ Previous** and **Next ›** (hidden on the first and last step). Moving
     opens the step's file with its thread expanded and collapses the step you left.
   - **Sidebar:** under the session, each walkthrough is its own row next to **Comments**,
     with its steps numbered inside. Steps aren't listed under Comments.

     ```
     ▾ Fix login                        idle · 1 replied
       ▸ Comments 3
       ▾ How hooks reach the sidebar    5 steps · new
           1  hook.ts:12                Claude sends the hook…
           2  broker.ts:40              The broker fans it out…
           3  brokerClient.ts:88        replied
     ```

     The walkthrough row shows its step count and **new** while any step is unopened; it
     starts expanded while new. Clicking it opens the first unopened step (or step 1).
     Actions: **Start**, **Resolve** (every step), **Reopen**, **Delete**. Steps show their
     number, file:line and first line of text, or their status once you've replied there.
     Exited sessions in History show their walkthroughs the same way.
   - **Previous / Next Step** also work from the keyboard (Ctrl+Alt+[ and Ctrl+Alt+]) and
     from the status bar, "‹ Step 3/5 ›", shown while you're in a walkthrough (click the
     count to leave it). They use the step you opened last; the sidebar selects it as you
     move.
   - **Replying:** a reply on a step goes to the session like any reply. `read_comments`
     shows which walkthrough a step is in and an outline of all its steps, so Claude can
     answer, change the walkthrough, or both.
   - **Editing:** `add_steps`, `edit_comment`, `remove_steps` and `update_walkthrough`.
     Claude can't remove a step you replied to (that would delete your words); it can add a
     step or edit its own text instead. Added steps are **new**; the instructions say to
     mention what changed in the reply. You can delete any step, or the whole walkthrough.
   - An exited session stays in the Sessions view while it has steps or comments from Claude
     you haven't opened, so a new walkthrough isn't buried in History.
   - **Badge:** a step adds nothing to VS Code's Comments badge until it has a thread you
     replied in and Claude answered; then it's a normal **replied** thread. Steps count in
     the session's replied count, and Next Reply visits them, on the same rule.
   - The instructions say: use a walkthrough when asked how something works across files,
     or to explain a change; use `add_comment` for a single point.

   Checked on Claude Code 2.1.310 with `claude -p` against fake storage: asked for a
   walkthrough, Claude built three correct steps with relative paths (resolved from its
   working directory) and flagged one thing with `add_comment`. After a reply on step 2
   asking for a step about `module.exports`, it inserted a new step 3 with `add_steps` and
   said so in the thread.

## Out of scope

Adding your own comments to a walkthrough, moving stored ranges when code moves (the
changed-since check only reports it), walkthroughs shared between sessions, and comments
on the old side of a diff.

## Done when

- `read_comments` can look up older comments by status, file and lines, and says whether the
  code changed since each comment.
- Claude can leave a comment on code that you can reply to.
- Claude can build a walkthrough across files that you step through with Previous / Next,
  reply on any step, and Claude can add, edit, remove and reorder its steps.

## Open questions

- **Following moved code:** update a comment's range when the changed-since check finds it
  moved, so editor threads follow the code?
- **Many walkthroughs:** group them under one **Walkthroughs** row per session once there
  are several?
- **Stale walkthroughs:** show "changed since" on a step's thread when you open it?
- **Keybindings:** Ctrl+Alt+[ / ] haven't been checked against other extensions' defaults.
