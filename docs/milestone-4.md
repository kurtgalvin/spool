# Milestone 4 — Code comments

Comment on code in any open file and send the comments to a session. Claude reads them
through a Spool MCP server and replies in each comment's thread. Builds on
[milestone 3](milestone-3.md); see [design.md](design.md) for the overall design.

## Intents

Each comment has one of three intents, which decide where it goes:

| Intent | Goes to | Context | Can edit |
|---|---|---|---|
| **Change** | Queued on a session; sent with others when you're ready | The session's | Yes |
| **Ask** | A new side thread branched from a session, read-only | The session's | No |
| **Fresh** | A new session in the file's folder group | None | Yes |

**Change** is the default. Queuing lets several comments go to one session as a single
review. **Ask** gets the session's context without cluttering its conversation or
interrupting its work.

## Comment statuses

- **draft**: written, no session chosen yet.
- **queued**: attached to a session, not sent yet.
- **sent**: the prompt was typed into the session.
- **read**: Claude fetched it with `get_comments`.
- **replied**: Claude posted a reply.
- **resolved**: Claude or you marked it done.

## Steps

1. **Comments and the queue.** A comment controller allows commenting on every `file:`
   document, including the current side of a diff. Add a comment from the gutter **+**, or
   select code and use **Comment for Claude** in the editor's context menu. Under the input,
   **Queue on Session** attaches it to a session; **Save as Draft** keeps it unattached. You
   pick the target from this window's running sessions; the file's folder group's sessions
   are listed first, and if it has only one it's marked **suggested** and preselected. A thread's title bar has
   **Queue on Session…** (for drafts, or to move a queued comment) and **Delete**; its label
   shows the status and session. Comments are saved as files in global storage (one per
   comment, like session files; every window shows them all), with the file, line range, a
   snapshot of the selected code, the text, the status, the session, and the replies. A
   session row shows its queued count. **Ask** and **Fresh** come with steps 3 and 4,
   **Send Comments** with step 3.
2. **Comments view.** A second view in the Spool sidebar shows comment threads as a file
   tree: folder group → folders → file → **threads as the leaves**. Single-child folder
   chains are compacted like the Explorer does. Each thread shows its status icon, the first
   line of the comment, and the target session. Clicking a thread opens the file at its
   line and expands the thread. Files and folders summarize the count of threads with
   replies you haven't read. (VS Code's own Comments panel lists the same threads flat;
   this view adds statuses and sessions.)
3. **Spool MCP server.** Every session Spool launches gets a `spool` stdio MCP server via
   `--mcp-config`. It's a small script with no dependencies, like `hook.ts`. Tools:
   - `get_comments`: the comments sent to this session, each with file, range, code, and
     text. Marks them **read**.
   - `reply(comment_id, text)`: adds a reply to the thread. Marks the comment **replied**.
   - `resolve(comment_id)`: marks the comment **resolved**.

   The server identifies its session by the `SPOOL_ID` it inherits from the terminal. Its
   tools take no session argument, so a session can only see its own comments. Sending
   types one line into the terminal, e.g. `Spool: 3 review comments, read them with
   get_comments and reply to each.` A single line avoids the multi-line problem. Our
   settings file allows `mcp__spool__*`, so the tools don't prompt. The window watches the
   comment files and updates the threads in the editor. Check first: that a server from
   `--mcp-config` inherits the terminal's environment, and that `--mcp-config` adds to the
   user's own MCP servers rather than replacing them.
4. **Read-only sessions.** A `PreToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit|Bash`
   denies the tool when the session is read-only, with the reason "Read only: answer
   instead of editing; reply with spool's reply tool." Read-only is a flag file per
   `SPOOL_ID` in global storage, so it can be turned on or off for any running session
   (**Make Read-Only** / **Allow Edits** on its row; the row shows **read-only**). The hook
   checks the file locally, without going through the broker. Bash is denied completely
   while read-only, because shell commands can write files. **Ask** branches a side thread
   with read-only on, then sends the comment to it.

## Out of scope

Comments on the old side of a diff, Claude starting comment threads itself (e.g. a review
pass that leaves comments), pushing comments with channels (custom channels need
`--dangerously-load-development-channels`, which warns on every launch), and following code
that moves after a comment was made (ranges are kept as written; the code snapshot shows
what was meant).

## Done when

- A comment on a selection in any file can be queued on a session, sent, and answered
  with a reply in its thread.
- Several queued comments go to one session in one send, and each gets its own reply.
- The comments view shows threads under their files with live statuses.
- **Ask** answers in a read-only side thread; an attempt to edit there is denied with the
  read-only reason.

## Open questions

- **Read-only fails open.** If hooks can't run (no `node` on PATH, see the
  [backlog](backlog.md)), read-only silently does nothing. Show a warning on sessions
  whose hooks have never fired, rather than claiming read-only?
- **Comments on exited sessions:** resume the session to deliver them, or move them back to
  draft?
- **Default routing:** a comment's `sessionId` decides where it goes. The picker always
  shows, suggesting the only running session in the file's group. Also suggest the
  last-focused or last-picked session?
- **After `/clear`:** a new session starts in the same terminal. Do the old session's
  queued comments move to it?
- **Comment UI:** intents as buttons under the input (Queue / Ask / Draft); turn on the
  reply box so you can follow up in a thread (follow-ups go to the thread's session); show
  Claude's icon on its replies; let you edit drafts and queued comments; let Claude leave
  comments itself (a `comment(file, lines, text)` tool) for review passes.
- **Row text:** "idle · 1 comment" gets truncated in a narrow sidebar; shorten it, or use an icon?
- **Clearing old threads:** delete resolved threads after a while, or keep them until
  you clear them?
