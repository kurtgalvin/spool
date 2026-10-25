# Milestone 4 — Code comments

Comment on code in any open file and send the comments to a session. Claude reads them
through a Spool MCP server and replies in each comment's thread. Builds on
[milestone 3](milestone-3.md); see [design.md](design.md) for the overall design.

## Destinations

A comment can go to one of three places. Any of them may answer or edit, depending on what
the comment asks.

| Destination | Goes to | Context |
|---|---|---|
| **Send / Queue** | A running session, now or with others when you're ready | The session's |
| **Branch** | A new side thread forked from a session | The session's, without cluttering its conversation |
| **New Session** | A new session in the file's folder group | None |

Queuing lets several comments go to one session as a single review.

## Comment statuses

- **draft**: written, no session chosen yet.
- **queued**: attached to a session, not sent yet.
- **sent**: the session was told about it.
- **read**: Claude fetched it with `get_comments`.
- **replied**: Claude posted a reply.
- **resolved**: you marked it done after reading the reply.

## Steps

1. **Comments and the queue.** A comment controller allows commenting on every `file:`
   document, including the current side of a diff. Add a comment from the gutter **+**, or
   select code and use **Comment for Claude** in the editor's context menu. The buttons
   under the input:
   - **Send**: to the current session, right away (just this comment; anything queued
     stays queued). **Cmd+Enter** runs it.
   - **Queue**: onto the current session's queue.
   - **More…**: a picker with fixed options first, then the running sessions:

     ```
     Branch from hello            side thread with its context
     New session in spool         no context
     Save as draft
     ─── Queue on a running session ───
     hello                        idle · spool · suggested
     fix-login                    working · api
     ```

   The current session is the one you last focused, in its terminal or in the sidebar; the
   input's placeholder names it. With none, Send and Queue open the session list. Sessions in
   the file's folder group are listed first; if it has only one it's marked **suggested**.
   (A split button would fit better, but extensions can't add one to the comment input.)

   A thread's title bar has **Queue on Session…** (for drafts, or to move a queued
   comment), **Resolve** / **Reopen**, and **Delete**; its label shows the status and
   session. Comments are saved as files in global storage (one per comment, like session
   files; every window shows them all), with the file, line range, a snapshot of the
   selected code, the text, the status, the session, and the replies. A session row shows
   its queued count.
2. **Comments in the sidebar.** The Sessions view shows whose turn it is. VS Code's own
   Comments panel already lists threads by file; what only Spool knows is which session a
   comment belongs to.
   - A session row shows **queued** (waiting for you to send) and **replied** (Claude
     answered, you haven't resolved it) counts; collapsed groups summarize replies like
     they summarize sessions needing input.
   - Expanding a session shows a **Comments** node (kept apart from its side threads) with
     its threads: status icon, file and line, first line of text. Clicking one opens the code
     with the thread expanded; inline actions send, resolve, or delete.
   - Comments sit under the session they went to, so branched comments appear under their
     side thread (nested under its parent) and new-session ones under their new session.
     Drafts, which have no session, are under a **Drafts** row at the top.
   - **Next Reply** (with a keybinding) cycles through threads Claude has answered.
   - Spool's activity-bar badge stays sessions needing input; VS Code's Comments badge
     covers replies.

   Later, maybe: a by-file grouping as a toggle on the same view, and a "needs me" filter.

3. **Spool MCP server.** Every session Spool launches gets a `spool` stdio MCP server via
   `--mcp-config`. It's a small script with no dependencies, like `hook.ts`. Tools:
   - `get_comments`: the comments sent to this session that have no reply yet, each with
     file, range, code, and the thread so far. Marks them **read**.
   - `reply(comment_id, text)`: adds a reply to the thread. Marks the comment **replied**.

   The server identifies its session by the `SPOOL_ID` it inherits from the terminal, and
   matches every session that ran in that terminal (so comments survive `/clear`). Its tools
   take no session argument, so a session can only see its own comments. **Send Comments**
   (send icon on a session row with queued comments) marks them **sent** and types one line
   into the session: `Spool: you have 2 code comments from me. Read them with the spool
   get_comments tool and reply to each.` Enter is sent separately, 150ms later, so Claude
   doesn't take it as part of a paste. A single line avoids the multi-line problem. Our
   settings file (now `spool-settings.json`) allows `mcp__spool`, so the tools don't prompt.
   The window watches the comment files and updates the threads in the editor.

   Once a comment has been sent, its thread has a reply box. **Reply** adds your follow-up
   and sends just that thread to the comment's session right away; **Reply Later** queues
   it with that session's comments. `get_comments` gives Claude the whole thread (labelled
   `User:` and `Claude:`) and asks it to answer the latest message.

   VS Code's Comments badge counts unresolved threads, and should only flag what needs you:
   so a thread is marked unresolved only once Claude has replied, and resolved when you
   **Resolve** it. Drafts, queued and sent threads have no state (checked in VS Code's
   source: the badge counts only threads explicitly unresolved). Claude doesn't resolve
   threads, so a reply always waits for you; the MCP server's `resolve` tool was dropped.

   Checked on Claude Code 2.1.310: the server inherits the terminal's environment;
   `${VAR}` expands in the config, so it's a fixed file in `resources/`; `--mcp-config`
   adds to the user's MCP servers (`--strict-mcp-config` would replace them). It takes
   several files, so it goes last on the command line. In a `-p` run against fake storage,
   Claude fetched two comments, fixed one and answered the other, replied to each, and left
   another session's comment and a still-queued one alone. A follow-up in a thread got an
   answer to the follow-up. Sessions started before this step have no Spool server;
   sending to one types a prompt Claude can't act on.

4. **Branch and New Session.** From **More…**: **Branch from <session>** forks the current
   session (`claude --resume <id> --fork-session`) in a new terminal, nested under it like
   any side thread; **New session in <group>** starts a session in the file's folder group.
   Either way the comment goes to the new session, already sent: the session starts with
   the one-line prompt as its first message, so nothing is typed into the terminal. With no
   current session, **Branch from…** asks which session to branch. These sessions are
   named from their comment (e.g. "Branch: what does markSent do") instead of from the
   prompt.

   Open: run branches as a background `claude -p --resume <parent> --fork-session` (no
   terminal, prompt as an argument) with **Continue in Terminal** to pick one up
   interactively. That needs a sidebar row for sessions without a terminal. Hooks still work
   if Spool passes `SPOOL_ID`.

## Out of scope

Comments on the old side of a diff, Claude starting comment threads itself (e.g. a review
pass that leaves comments), pushing comments with channels (custom channels need
`--dangerously-load-development-channels`, which warns on every launch), following code
that moves after a comment was made (ranges are kept as written; the code snapshot shows
what was meant), and read-only sessions (Claude hasn't edited when asked a question so far;
the design is in the [backlog](backlog.md)).

## Done when

- A comment on a selection in any file can be queued on a session, sent, and answered
  with a reply in its thread.
- Several queued comments go to one session in one send, and each gets its own reply.
- Each session in the sidebar shows its comments with live statuses, and which sessions
  have replies waiting.
- A comment can start a side thread or a new session, which answers it.

## Open questions

- **Comments on exited sessions:** resume the session to deliver them, or move them back to
  draft?
- **Default routing:** also suggest the last-picked session?
- **After `/clear`:** a new session starts in the same terminal. Do the old session's
  queued comments move to it?
- **Comment UI:** show Claude's icon on its replies; let you edit drafts and queued
  comments; let Claude leave comments itself (a `comment(file, lines, text)` tool) for
  review passes.
- **Row text:** "idle · 1 comment" gets truncated in a narrow sidebar; shorten it, or use an
  icon?
- **Clearing old threads:** delete resolved threads after a while, or keep them until
  you clear them?
- **Ambiguous comments** ("this looks off?") could be read as a question or a change. If
  Claude edits when you didn't want it to, first tell it (in the MCP instructions) to treat
  uncertain comments as questions; read-only is the fallback.
