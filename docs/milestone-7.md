# Milestone 7 — No Node needed, and releases on GitHub

Make Spool installable without Node or Rust: download a `.vsix` from the repo's GitHub
Releases and install it. Today the hooks and the MCP server both run with `node` from PATH,
so with Claude's native installer and no Node every hook fails silently and the sidebar never
updates. See [design.md](design.md) for the overall design; this is the first half of a
Marketplace release.

## Steps

1. **The hook in Rust.** `hook/` is a small crate, standard library only, building
   `spool-hook`: read the payload from stdin, wrap it as `{"spoolId": …, "payload": …}` on one
   line, write it to `SPOOL_SOCKET`, exit.
   - Same rules as the Node script it replaces (`src/hook.ts`, deleted): always exits 0,
     prints nothing, gives up after 2 seconds, does nothing without `SPOOL_ID` and
     `SPOOL_SOCKET`. `spool-hook --version` prints its version, for the startup check.
   - The payload isn't parsed: it's checked to be one JSON object, and line breaks (only
     possible between tokens in valid JSON) become spaces so it stays one line. The extension
     already parses defensively.
   - Built per platform into `bin/<platform>-<arch>/spool-hook`, named after Node's
     `process.platform` and `process.arch` (`darwin-arm64`, `darwin-x64`, `linux-x64`,
     `linux-arm64`). `npm run build:hook` builds the current platform's with cargo.
   - The hook settings run `"$SPOOL_HOOK"`, the binary's path, set in each session's
     terminal like `SPOOL_ID`.
   - No fallback to the Node script: a second code path would go untested. Instead the
     startup check (step 3) makes a missing or broken binary loud.

2. **The MCP server on the editor's runtime.** Like the broker, `out/mcp.js` runs with the
   editor's own executable and `ELECTRON_RUN_AS_NODE=1`: the MCP config's command is
   `${SPOOL_NODE}`, set in the terminal to the extension host's `process.execPath`, with the
   variable in the server's `env`. It starts once per session, so its startup time doesn't
   matter.

3. **Startup check.** On activation the extension makes sure the hook binary for this
   platform exists and is executable (setting the bit if a `.vsix` lost it), then runs it with
   `--version`. If that fails, an error says so, with the reason: no build for this platform,
   or the binary couldn't run (e.g. blocked by macOS). Sessions still start, but won't update.

4. **Releases.** A GitHub Actions workflow on tags `v*`:
   - builds `spool-hook` for the four targets (macOS on a macOS runner for both
     architectures; Linux as static musl binaries on x64 and arm64 runners);
   - checks the tag matches `package.json`'s version;
   - packages one `.vsix` holding every binary, and attaches it to a GitHub Release.

5. **README:** install from the latest release (`code --install-extension spool.vsix`, or
   `cursor …`); installing from a clone also needs Rust.

## Done when

- A machine with the editor and Claude Code, but no Node or Rust, installs Spool from a
  release and gets live statuses and the comment tools.
- A missing or broken hook binary shows an error instead of a silent sidebar.

## Notes

- Sessions running when Spool updates keep the old extension's paths until restarted, as
  before; an update that removes the old extension folder breaks their hooks.
- The binaries aren't signed. Files the editor extracts from a `.vsix` don't normally get
  macOS's quarantine flag; check on a second Mac. If they do, the startup check reports it.
