# Milestone 5 — Session history

See the Claude conversations for your folders that Spool isn't showing, and bring any of them
into Spool: ones started in a plain terminal or another editor, from before Spool existed, or
removed from the Sessions view. Builds on [milestone 4](milestone-4.md); see
[design.md](design.md) for the overall design.

## Where the conversations come from

Claude Code saves each conversation as `~/.claude/projects/<folder>/<session-id>.jsonl`,
where `<folder>` is the working directory with every character other than a letter or digit
replaced by `-`. Spool only reads these files. Checked on Claude Code 2.1.310:

- The cwd, `entrypoint` and git branch are on each user message line. `-p` runs have
  `entrypoint: sdk-cli` and are left out.
- Titles are re-appended through the file as they change, so the last one wins:
  `custom-title` (from `/rename`), then `ai-title` (generated), then `last-prompt`.
- Subagents' transcripts are in a subfolder next to the file, so only top-level files count.
- Running Claude processes register in `~/.claude/sessions/<pid>.json` with their session
  id, cwd, name and status. A conversation whose process is alive is **running elsewhere**.

Neither format is documented, so parsing is defensive: unknown lines are skipped, and a file
that can't be read is left out.

## Steps

1. **History view.** A second view, **History**, under Sessions in Spool's sidebar,
   collapsed by default (`"visibility": "collapsed"`). It's only scanned while visible.
   - Grouped by folder group, like Sessions, for the open workspace folders. A group's
     conversations come from the project folders for its directory and its subfolders, kept
     only if the cwd in the file really is inside the group.
   - Conversations Spool already lists (by Claude session id) are left out, so a removed
     session reappears here.
   - Each row: the title, then when it was last active and its subfolder or git branch. Newest
     first, up to 50 per group. The tooltip has the first and last prompts, the cwd and the
     session id. A conversation running elsewhere gets its own icon and says so.
   - Reading: the start of the file (first user message: cwd, entrypoint, branch, first
     prompt) and its last 256 KB (titles, last prompt). Results are cached by mtime and size;
     transcripts can be many MB.
   - Refreshes when shown, when Spool's sessions change, and when a project folder changes
     (debounced), plus a **Refresh** button.
2. **Bringing a conversation into Spool.**
   - **Resume in Spool**: adds it to the Sessions view as an exited session (named from its
     title) and resumes it there with `claude --resume <id>` in its cwd. From then on it's an
     ordinary Spool session; the row leaves History.
   - **Branch**: starts a new Spool session forked from it (`--resume <id> --fork-session`),
     leaving the original in History.
   - Resuming one that's running elsewhere asks first: two processes writing one
     conversation would interleave it. Branching is safe.
   - **Hide**: removes a row from History, saved in Spool's storage. Transcripts are never
     deleted.

## Out of scope

Searching inside conversations, folders not open in the window (an "all projects" toggle
later), showing conversations running elsewhere in the Sessions view with live status, and
paths long enough that Claude Code shortens the folder name.

## Done when

- The History view lists this folder's conversations that Spool doesn't, with useful titles,
  and leaves out `-p` runs and subagents.
- A conversation started in a plain terminal can be resumed or branched into Spool.
- A conversation still running elsewhere is marked, and resuming it asks first.

## Open questions

- Show conversations running elsewhere in the Sessions view instead, with their status from
  the registry? It could replace the "other window" mirroring for non-Spool processes.
- Offer **Take Over** for one running elsewhere: tell you to quit it there, then resume here.
