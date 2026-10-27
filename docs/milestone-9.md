# Milestone 9 — Detach side threads, send queued comments

Two fixes to how things show in the sidebar: a side thread that has become its own piece of
work can be moved out from under its parent, and comments queued on a session get a send
button you can find. See [design.md](design.md) for the overall design.

## Today

- **Side threads** nest under their parent whenever the parent is listed in the same group
  (`parentOf` in `sessionTree.ts`, `nestedUnder` in `historyTree.ts`). `parentId` is the only
  link, and nothing changes it after the branch.
- **Send Comments** (`spool.sendComments`) already sends everything queued on a session, but
  it's easy to miss:
  - in the sidebar it's an inline ✈ on the session row, which VS Code shows only while the
    row is hovered or selected, and in the row's right-click menu;
  - a queued comment's row has its own inline ✈, which sends just that comment;
  - in the editor, a queued thread has no send action at all, only **Queue on Session…**;
  - it's hidden from the Command Palette;
  - it needs the session running in this window, so comments queued on an exited session
    can't be sent from anywhere.

## Steps

1. **Detach from Parent.**
   - A new field, `detached?: boolean`, on the session. `parentId` stays: it still records
     where the thread came from, and naming uses it (a fork's transcript has its parent's
     `ai-title`, so side threads are named from their first prompt even once detached).
   - **Detach from Parent** in a nested thread's right-click menu sets `detached`. The thread
     moves to its group's top level, with any threads of its own still nested under it.
     `parentOf` and `nestedUnder` return nothing for a detached session.
   - A detached thread's row doesn't say "from <parent>"; the tooltip says "Branched from
     <parent>".
   - **Nest Under Parent** on a detached thread undoes it, shown only while its parent is
     listed in the same group.
   - The row's `contextValue` gets `:nested` or `:detached` (after `:conversation`, before
     `:comments`, so the existing `when` patterns still match).
   - Sessions running in another window get neither action, like the rest.
   - In History, the same two actions on exited threads.

2. **A send row under the session.** When comments are queued on a session, the first row
   under it is **Send 3 Queued Comments** (✈ icon), always visible; clicking it runs Send
   Comments. The session row keeps its inline ✈ and "3 queued" in its description.
   - The queued comment rows' own ✈ stays as **Send This Comment**, so it's clear it sends
     one.
   - If the session has exited, the row says **Resume and Send 3 Queued Comments**: it
     resumes the session (`--resume`) with the comments prompt as the first message on the
     command line, the way a comment's **More… › New session** starts one, so nothing is
     typed into the TUI. Sessions running in another window get no row (that window sends).

3. **Send from the editor.** A queued thread's title bar gets **Send** (✈) next to **Queue
   on Session…**. It sends every comment queued on that session, not just this one, and its
   tooltip says how many ("Send 3 queued comments to <session>"). If the session isn't
   running here, it says so, as the sidebar's per-comment send does today.

4. **Command Palette.** **Spool: Send Queued Comments…** lists the sessions with comments
   queued on them (with counts) and sends to the one you pick; with only one, it sends right
   away.

## Done when

- A side thread can be moved to the top level and back, and stays where you put it after a
  reload.
- Queued comments on a session can be sent with one visible click from the sidebar or the
  editor, including on a session that has exited.

## Notes

- Detach is only about where the thread is shown: the fork is already its own conversation.
- Open question: should a thread detach itself when its parent exits and moves to History?
  Today it shows at the top level with "from <parent>", which is the same thing; leaving it.
- Bulk sends from the editor go to one session. A "send everything queued anywhere" action
  isn't planned: comments on different sessions are different conversations.
