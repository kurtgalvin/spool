# Milestone 8 — Session names from Claude

Sessions name themselves: a new session takes Claude Code's own title for the conversation,
and **Let Claude Name It** asks a running session to pick a new short name for itself. Today
a session is named from the first line of its first prompt (`naming.ts`), which is often a
poor name. See [design.md](design.md) for the overall design.

## Claude Code's titles

Claude Code writes a generated title into the transcript as `{"type": "ai-title", "aiTitle":
…}` (Spool's History view already reads it). Checked against recent transcripts on Claude
Code 2.1.310:

- It's written right after the first prompt, before Claude's first reply.
- It never changes: one distinct title per conversation, even over hundreds of prompts.
- They're short: "Batch mode feasibility", "Comment flow from editor to session".
- A forked conversation (a side thread) carries its parent's title and doesn't get its own.

## Steps

1. **Names from `ai-title`.**
   - A new session is named **New session** (`nameSource: 'default'`), replacing today's
     numbered "Claude 1", "Claude 2".
   - From its first `UserPromptSubmit`, Spool looks for the title on every hook for the
     session, and again a few seconds after the prompt (a reply with no tools fires only
     `Stop`). The extension does this (the hook only forwards events), reading the transcript at
     the hook payload's `transcript_path`, or `~/.claude/projects/<project dir>/<session
     id>.jsonl` (`projectDirName` from `history.ts`) if it's missing. It reads from the
     top until the first title: newer Claude Code versions write a few hundred KB of setup
     records (tool and skill listings) before it.
   - When found, it becomes the name (`nameSource: 'auto'`), the terminal tab follows, and
     Spool stops looking. Nothing automatic changes it after that.
   - **Fallback:** if the session reaches `Stop` with no title, it's named from the first
     prompt as today (`nameFromPrompt`), so it never stays **New session**.
   - **Side threads** keep today's naming (from their first prompt), since their transcript
     only has the parent's title.
   - Unchanged: resumed sessions keep their name; `/clear` already starts a new session in
     the terminal, which gets named the same way; sessions given a name when created (from a
     comment's **More…**) keep it; existing sessions keep their names.

2. **`rename_session(name)`**, a new MCP tool.
   - The MCP server doesn't write session files (the window that owns a session does), so the
     tool sends a message over the broker socket like a hook does (`SPOOL_SOCKET` is in its
     environment): `{spoolId, payload: {hook_event_name: 'SpoolRename', session_id, name}}`,
     with the Claude session id from the session's file so it routes to the current session.
   - The extension handles `SpoolRename` before status updates (it changes no status) and
     renames the session with a new name source, `nameSource: 'agent'`, next to `default`
     (not named yet), `auto` (from the title or first prompt) and `user` (**Rename…**). Like
     `user`, nothing automatic changes it; the tooltip says "Named by the agent". The terminal
     tab follows.
   - The name is trimmed and must be one line of at most 40 characters; otherwise the tool
     returns an error saying so, and the window ignores it too.
   - The tool then waits up to 3 seconds for the window to save the new name to the session's
     file, and returns an error if it doesn't (e.g. the window that owns the session is closed).
   - The instructions say: call it only when asked to name or rename the session; a short
     name, 2–4 words, for what the session is working on.

3. **Let Claude Name It.**
   - A command, **Let Claude Name It**, types into the session (like comment prompts): "Spool:
     name this session. Call the spool rename_session tool with a short name, 2–4 words, for
     what we're working on, then carry on." While the session is working, the line waits
     behind the current task, so the name changes when Claude gets to it.
   - **Sidebar:** in a running session's right-click menu, after **Rename…**:

     ```
     Rename…
     Let Claude Name It
     Branch Side Thread
     ───────────
     Mark Idle
     ───────────
     Kill
     ```

     Running means starting, working, needs input or idle; an exited session can't take it.
   - **Rename box:** **Rename…** opens an input box with a ✨ button in its title bar
     (`createInputBox` with `buttons`). Clicking it closes the box and runs Let Claude Name
     It. Shown only for running sessions.
   - **Command Palette:** **Spool: Let Claude Name Session**, with a picker of running
     sessions.

Checked on Claude Code 2.1.310: the hook payloads carry `transcript_path`. Given the Let
Claude Name It line in a `claude -p` run, with a fake broker standing in for the window, Claude
called `rename_session` with "Rust hook release workflow" and said so. Store tests cover naming
from the title on the prompt, on a later hook and from the retry; the first-prompt fallback at
Stop; side threads; `/resume`; user and agent renames; and bad names.

## Done when

- A new session shows **New session**, then Claude Code's title after its first prompt, and
  keeps it.
- **Let Claude Name It** on a running session renames it to a short name Claude picks.

## Notes

- Sessions started before the update keep the old MCP server, so they don't have
  `rename_session` until restarted; Let Claude Name It on one would get "no such tool".
- The request and Claude's answer stay in the conversation, and it uses a turn.
- A session whose first prompt is a Spool comment prompt gets a title like "Spool code
  comments"; Let Claude Name It fixes that.
