import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BrokerClient } from './brokerClient';
import { CodeComment, CommentStore } from './comments';
import { CommentThreads, pickSessionFor } from './commentThreads';
import { FolderGroup } from './groups';
import { brokerSocketPath } from './ipc';
import { watchNeedsInput } from './notifications';
import { JsonFiles } from './persistence';
import { SavedSession, Session, SessionStore } from './sessions';
import { SessionTreeProvider } from './sessionTree';

const LIVENESS_CHECK_MS = 5_000;

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Spool', { log: true });
  context.subscriptions.push(log);

  const storageDir = context.globalStorageUri.fsPath;
  const sessionFiles = new JsonFiles<SavedSession>(path.join(storageDir, 'sessions'));
  const store = new SessionStore(log, sessionFiles);
  const syncSessions = () =>
    store.sync(vscode.window.terminals, (terminal) => withTimeout(terminal.processId, 1000), isInOpenFolder);
  // Other windows' sessions update through their files. The timer catches windows that closed
  // without updating them (their shells are gone).
  const livenessTimer = setInterval(syncSessions, LIVENESS_CHECK_MS);
  context.subscriptions.push(
    store,
    sessionFiles.watch(syncSessions),
    { dispose: () => clearInterval(livenessTimer) },
    vscode.window.onDidCloseTerminal((terminal) => store.handleTerminalClosed(terminal)),
    vscode.window.onDidOpenTerminal(() => syncSessions()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncSessions()),
  );
  // Before connecting, so hooks (including ones the broker replays) find their sessions.
  await syncSessions();

  const commentFiles = new JsonFiles<CodeComment>(path.join(storageDir, 'comments'));
  const comments = new CommentStore(commentFiles);
  const threads = new CommentThreads(comments, store);
  context.subscriptions.push(comments, threads, commentFiles.watch(() => comments.sync()));

  const broker = new BrokerClient(
    brokerSocketPath(),
    context.extension.packageJSON.version,
    context.asAbsolutePath('out/broker.js'),
    path.join(storageDir, 'broker.log'),
    (message) => {
      log.debug(`hook from ${message.spoolId}: ${JSON.stringify(message.payload)}`);
      store.handleHook(message);
    },
    log,
  );
  context.subscriptions.push(broker);
  try {
    await broker.connect();
  } catch (err) {
    // Keep the rest of Spool usable; sessions just won't update until the broker is reachable.
    log.error((err as Error).message);
  }

  const settingsPath = context.asAbsolutePath('resources/spool-hooks.json');
  const hookScriptPath = context.asAbsolutePath('out/hook.js');
  const openTerminal = (terminalId: string, name: string, cwd?: string | vscode.Uri) =>
    vscode.window.createTerminal({
      name,
      cwd,
      env: {
        SPOOL_ID: terminalId,
        SPOOL_SOCKET: broker.socketPath,
        SPOOL_HOOK_SCRIPT: hookScriptPath,
      },
      iconPath: new vscode.ThemeIcon('sparkle'),
    });
  const runClaude = (session: Session, ...args: string[]) => {
    // Run claude through the user's shell so it gets their normal PATH and profile.
    session.terminal?.sendText(`claude ${['--settings', settingsPath, ...args].map(shellQuote).join(' ')}`);
    session.terminal?.show();
  };

  context.subscriptions.push(
    // From a group's row: start in that group's folder. Otherwise in a workspace folder.
    vscode.commands.registerCommand('spool.newSession', async (group?: FolderGroup) => {
      const launchDir = group?.dir ?? (await pickWorkspaceFolder());
      if (!launchDir) {
        return;
      }
      const terminalId = randomUUID();
      runClaude(store.create(terminalId, launchDir, (name) => openTerminal(terminalId, name, launchDir)));
    }),
    vscode.commands.registerCommand('spool.resumeSession', (session: Session) => {
      if (!session.claudeSessionId) {
        return;
      }
      const terminalId = randomUUID();
      store.resume(session, terminalId, (name) => openTerminal(terminalId, name, session.cwd));
      runClaude(session, '--resume', session.claudeSessionId);
    }),
    vscode.commands.registerCommand('spool.branchSession', (parent: Session) => {
      if (!parent.claudeSessionId) {
        return;
      }
      const terminalId = randomUUID();
      // The fork must run where the parent's conversation lives for --resume to find it.
      const cwd = parent.cwd ?? parent.launchDir;
      const thread = store.branch(parent, terminalId, (name) => openTerminal(terminalId, name, cwd));
      runClaude(thread, '--resume', parent.claudeSessionId, '--fork-session');
    }),
    vscode.commands.registerCommand('spool.focusSession', (session: Session) => {
      session.terminal?.show();
    }),
    vscode.commands.registerCommand('spool.renameSession', async (session: Session) => {
      const name = (await vscode.window.showInputBox({ prompt: 'Session name', value: session.name }))?.trim();
      if (!name) {
        return;
      }
      store.rename(session, name);
      if (session.terminal) {
        // The rename command only targets the active terminal, so focus it first.
        session.terminal.show(true);
        await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
      }
    }),
    vscode.commands.registerCommand('spool.killSession', (session: Session) => {
      // onDidCloseTerminal marks the session exited.
      session.terminal?.dispose();
    }),
    vscode.commands.registerCommand('spool.restartBroker', () => broker.restartBroker()),
    vscode.commands.registerCommand('spool.markIdle', (session: Session) => store.markIdle(session)),
    vscode.commands.registerCommand('spool.removeSession', (session: Session) => store.remove(session)),

    // Comments. The first two are the buttons under a new thread's input box.
    vscode.commands.registerCommand('spool.queueComment', async (reply: vscode.CommentReply) => {
      // Cancelling the pick leaves the input as it is.
      const session = await pickSessionFor(reply.thread.uri.fsPath, store);
      if (session) {
        await threads.create(reply, session);
      }
    }),
    vscode.commands.registerCommand('spool.saveCommentDraft', (reply: vscode.CommentReply) =>
      threads.create(reply, undefined),
    ),
    vscode.commands.registerCommand('spool.queueDraft', async (thread: vscode.CommentThread) => {
      const comment = threads.commentFor(thread);
      const session = comment && (await pickSessionFor(comment.file, store));
      if (comment && session) {
        comments.queue(comment, session.id);
      }
    }),
    vscode.commands.registerCommand('spool.deleteComment', (thread: vscode.CommentThread) => {
      const comment = threads.commentFor(thread);
      if (comment) {
        comments.delete(comment);
      }
    }),
    // Opens the comment input on the selection; VS Code asks which extension if several offer comments.
    vscode.commands.registerCommand('spool.commentOnSelection', () =>
      vscode.commands.executeCommand('workbench.action.addComment'),
    ),
  );

  const view = vscode.window.createTreeView('spool.sessions', { treeDataProvider: new SessionTreeProvider(store, comments) });
  context.subscriptions.push(
    view,
    watchNeedsInput(store, view),
    store.onDidChangeTerminalName(renameTabIfActive),
    // Keep the sidebar selection on the active session: when the active terminal changes,
    // and when a new session takes over the active terminal.
    vscode.window.onDidChangeActiveTerminal(selectActiveSession),
    store.onDidTakeOverTerminal(() => selectActiveSession(vscode.window.activeTerminal)),
  );

  function selectActiveSession(terminal: vscode.Terminal | undefined): void {
    const session = store.findByTerminal(terminal);
    if (session && view.visible) {
      view.reveal(session, { select: true, focus: false });
    }
  }
}

export function deactivate() {}

/**
 * VS Code can only rename the active terminal. These renames happen in the background, so
 * rename the tab only if it's already active rather than stealing focus.
 */
async function renameTabIfActive(session: Session): Promise<void> {
  if (session.terminal && vscode.window.activeTerminal === session.terminal) {
    await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: session.name });
  }
}

/**
 * The folder for a new session: the only workspace folder, the one picked when there are
 * several (undefined if the pick is cancelled), or home when no folder is open — where a
 * terminal would start anyway.
 */
async function pickWorkspaceFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) {
    return folders[0]?.uri.fsPath ?? os.homedir();
  }
  return (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Start the session in…' }))?.uri.fsPath;
}

/** Exited sessions are shown in windows that have their folder open, so they can be resumed there. */
function isInOpenFolder(session: SavedSession): boolean {
  const cwd = session.launchDir ?? session.cwd;
  return !!cwd && !!vscode.workspace.workspaceFolders?.some((folder) => {
    const relative = path.relative(folder.uri.fsPath, cwd);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
