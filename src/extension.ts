import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { IpcServer } from './ipc';
import { watchNeedsInput } from './notifications';
import { SessionTreeProvider } from './sessionTree';
import { Session, SessionStore } from './sessions';

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Spool', { log: true });
  context.subscriptions.push(log);

  const store = new SessionStore(log);
  context.subscriptions.push(
    store,
    vscode.window.onDidCloseTerminal((terminal) => store.handleTerminalClosed(terminal)),
  );

  const ipc = new IpcServer(
    (message) => {
      log.debug(`hook from ${message.spoolId}: ${JSON.stringify(message.payload)}`);
      store.handleHook(message);
    },
    (error) => log.error(error.message),
  );
  await ipc.start();
  context.subscriptions.push(ipc);
  log.info(`IPC listening on ${ipc.socketPath}`);

  const settingsPath = context.asAbsolutePath('resources/spool-hooks.json');
  const hookScriptPath = context.asAbsolutePath('out/hook.js');
  let sessionCount = 0;

  context.subscriptions.push(
    vscode.commands.registerCommand('spool.newSession', () => {
      const spoolId = randomUUID();
      const name = `Claude ${++sessionCount}`;
      const terminal = vscode.window.createTerminal({
        name,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri,
        env: {
          SPOOL_ID: spoolId,
          SPOOL_SOCKET: ipc.socketPath,
          SPOOL_HOOK_SCRIPT: hookScriptPath,
        },
        iconPath: new vscode.ThemeIcon('sparkle'),
      });
      // Run claude through the user's shell so it gets their normal PATH and profile.
      terminal.sendText(`claude --settings ${shellQuote(settingsPath)}`);
      terminal.show();
      store.add({ spoolId, name, status: 'starting', terminal });
      log.info(`started ${name} (${spoolId})`);
    }),
    vscode.commands.registerCommand('spool.focusSession', (session: Session) => {
      session.terminal?.show();
    }),
  );

  const view = vscode.window.createTreeView('spool.sessions', { treeDataProvider: new SessionTreeProvider(store) });
  context.subscriptions.push(
    view,
    watchNeedsInput(store, view),
    // Keep the sidebar selection on the active session, however the terminal was focused.
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      const session = store.findByTerminal(terminal);
      if (session && view.visible) {
        view.reveal(session, { select: true, focus: false });
      }
    }),
  );
}

export function deactivate() {}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
