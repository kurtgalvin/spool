# Ideas

Bigger directions from a brainstorm after [milestone 6](milestone-6.md) (2026-10-25). Less
settled than the [backlog](backlog.md): each needs a design pass before it's a milestone.
Most of them combine pieces Spool already has: the broker sees every hook from every
session, each session runs an MCP server Spool controls, comment threads are a two-way
channel anchored to code, and History can read any conversation.

## Sessions and pull requests

Tie a session to the branch and pull request it's working on, so when a PR gets review
comments you can pull up the session that wrote the code, with its context, instead of
starting cold.

- **Linking.** A session records its git branch: from the `cwd` at start, and Claude's
  transcripts already carry `gitBranch` on every user line, so History conversations get it
  too. The PR comes from the branch (`gh pr view <branch> --json number,url,state`), checked
  now and then while the session is around. A session can also be linked by hand ("Link to
  PR…"), and a session that opens a PR (`gh pr create` in a PostToolUse hook) links itself.
- **Sidebar.** The session row shows `#123` and the PR's state (open, approved, changes
  requested, merged). Several sessions can share a PR (the original one, a side thread
  fixing review comments); a PR row could group them.
- **Find the session for a PR.** A command, "Open Session for PR…", picks from open PRs
  (yours, or the current branch's) and opens the session that worked on it, or resumes the
  newest conversation on that branch from History if it exited. From the other direction: a
  link or `gh` URL handler, so a PR page could open its session.
- **Review comments come in as Spool comments.** New review comments on the PR (polled with
  `gh api`) show up as threads on their lines, attached to the linked session, marked as
  from the reviewer. Sending them works like your own comments: Claude reads them with
  `read_comments`, makes the change or answers. The session row gets "3 review comments"
  and a toast.
- **Replies go back to GitHub, only when you say so.** Claude's reply sits in the thread;
  a **Post to PR** action posts it as a reply on the review comment, from your account via
  `gh`. Never automatic: it's public and under your name.
- **Merged or closed** PRs mark their sessions done, a hint they can be cleared.
- Open questions: polling cost and rate limits (only for linked, open PRs, and only while a
  window is open); GitHub only at first, through `gh` so there's no token handling in
  Spool; how review comments on old commits map to current lines (the changed-since check
  helps).

## Sessions working together

- **Claude reviewing Claude.** A reviewer session gets a worker session's changes and
  leaves `add_comment` notes on the changed lines. They're delivered to the worker, which
  fixes or answers them, and you watch the conversation happen in the editor and can join
  any thread. Most of this exists; the missing piece is comments addressed to another
  session (`add_comment(..., to: session)`) and a way to start the reviewer on a diff.
- **A coordinator session.** MCP tools like `start_session(folder, prompt)`,
  `session_status()` and `send_to_session(id, text)`. One Claude splits a task, starts
  sessions in visible terminals, and follows their statuses through the broker.
  Multi-agent work you can see and step into, instead of hidden subagents.
- **Side threads report back** (on the roadmap). A side thread sends a summary to its
  parent, which arrives as a comment or a typed message there.

## Knowing what happened

- **Which session wrote this line.** PostToolUse hooks already say which session edited
  which file. Editor decorations or hovers: "edited by *Fix login*, 4m ago"; clicking jumps
  to the session.
- **Two sessions on one file.** The broker sees every edit, so it can warn when two
  sessions edit the same file before they clash.
- **While you were away.** A digest per session: files touched, commands run, where it's
  waiting. Could be an automatic walkthrough of what changed.
- **Cost and tokens per session.** Transcripts record usage; show it on rows and totals on
  groups.

## More ways to talk to sessions

- **Claude asks you a question.** An `ask_user(question, options)` tool that shows a toast
  or quick pick, with the answer going straight back, so you don't have to find the
  terminal that's waiting.
- **Drag and drop.** Drag a file, a selection or a failing test onto a session row to send
  it as context.
- **From your phone.** Remote control (see the backlog's Remote Control button) plus
  Spool's needs-input signal: answer or approve from your phone when a session is waiting.

## Walkthroughs beyond explanations

- **"Explain your change" on Stop.** When a session finishes a task, it builds a
  walkthrough of its diff, so you review a guided tour instead of a raw diff.
- **PR reviews.** A walkthrough of a pull request, whose step comments can become GitHub
  review comments (pairs with sessions and pull requests above).
- **Onboarding.** Export to CodeTour (in the backlog) turns good walkthroughs into docs the
  repo keeps.

## Workflow

- **Task board.** Cards are prompts. When a session goes idle, the next card starts in it,
  or in a new session on its own worktree.
- **Session roles.** Presets like reviewer, tester or read-only explorer: a starting
  prompt, tool permissions (read-only is in the backlog) and extra MCP instructions per
  role.
