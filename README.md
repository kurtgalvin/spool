# Spool

A VS Code (and Cursor) extension for running several Claude Code sessions side by side:

- **Sessions sidebar** with live status from Claude Code hooks (working, needs input, idle),
  grouped by folder, across all your windows, with a toast when a session needs you.
- **Side threads**: branch a session into a fork that has its context, without cluttering it.
- **Code comments**: comment on code in any file and send it to a session; Claude reads it and
  replies in the thread. Claude can also leave you comments and **walkthroughs**, ordered steps
  across files that you move through with Previous / Next and can reply on.
- **History**: exited sessions, and Claude conversations for your folders that Spool didn't
  start, ready to resume or branch.

Not affiliated with Anthropic. See [docs/design.md](docs/design.md) for how it works.

## Requirements

- macOS or Linux (Windows isn't supported yet).
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed, with `claude` on your
  PATH.

## Install

Download the [latest release](https://github.com/kurtgalvin/spool/releases/latest) and install
it:

```sh
# VS Code
curl -fsSL https://github.com/kurtgalvin/spool/releases/latest/download/spool.vsix -o /tmp/spool.vsix && code --install-extension /tmp/spool.vsix

# Cursor
curl -fsSL https://github.com/kurtgalvin/spool/releases/latest/download/spool.vsix -o /tmp/spool.vsix && cursor --install-extension /tmp/spool.vsix
```

(Or download `spool.vsix` from the release page and drag it into the editor's Extensions
view.) Then reload the editor window (**Developer: Reload Window** in the Command Palette).

The `code` and `cursor` commands come from the editor: if one isn't found, run **Shell
Command: Install 'code' command in PATH** (or **'cursor'**) from its Command Palette first.

To update, run the same command again and reload. If an update changes the
broker (the background process that relays hooks), also run **Spool: Restart Broker**.

### From a clone

Building Spool yourself also needs Node.js with npm, and [Rust](https://rustup.rs) for the
hook:

```sh
git clone https://github.com/kurtgalvin/spool.git
cd spool
npm install
npm run install:code     # VS Code
npm run install:cursor   # Cursor
```

To update: `git pull`, run the install script again, and reload.

## Use

Open the Spool icon in the activity bar.

- **+** on a folder starts a Claude session there. Sessions started from Spool are the ones
  it tracks; sessions in plain terminals show up under **History › Not in Spool**.
- To comment on code, click the **+** in the editor gutter (or select code and use **Comment
  for Claude** in the context menu), then **Send** to the current session, **Queue** it for
  later, or **More…** to branch or start a new session with it.
- **Next Reply** (Cmd+Alt+N, Ctrl+Alt+N elsewhere) jumps between Claude's replies.
- Ask a session how something works across files and it builds a walkthrough;
  Ctrl+Alt+[ and Ctrl+Alt+] move between steps.

Sessions and comments are per editor: VS Code and Cursor each keep their own.
