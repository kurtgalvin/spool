# Spool

A VS Code extension for managing multiple Claude Code terminal sessions: live status from
Claude Code hooks, sessions grouped by folder across windows, needs-input notifications, and
side threads. See `docs/design.md` in the repo.

## Install locally

```sh
npm install
npm run install-local   # builds spool.vsix and installs it into VS Code
```

Then run **Developer: Reload Window**. To update, bump `version` in `package.json` and run
`npm run install-local` again; a newer version replaces the running broker automatically.
