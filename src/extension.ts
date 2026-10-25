import { randomUUID } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BrokerClient } from './brokerClient';
import { CodeComment, CommentStore } from './comments';
import { CommentThreads, pickBranchParent, pickDestination, pickSession } from './commentThreads';
import { nameFromPrompt } from './naming';
import { FolderGroup } from './groups';
import { Conversation } from './history';
import { HistoryTreeProvider } from './historyTree';
import { brokerSocketPath } from './ipc';
import { watchNeedsInput } from './notifications';
import { JsonFiles } from './persistence';
import { SavedSession, Session, SessionStore } from './sessions';
import { SessionTreeProvider, isSession } from './sessionTree';

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

  // Hooks, and permission for Spool's MCP tools.
  const settingsPath = context.asAbsolutePath('resources/spool-settings.json');
  const mcpConfigPath = context.asAbsolutePath('resources/spool-mcp.json');
  const hookScriptPath = context.asAbsolutePath('out/hook.js');
  const openTerminal = (terminalId: string, name: string, cwd?: string | vscode.Uri) =>
    vscode.window.createTerminal({
      name,
      cwd,
      env: {
        SPOOL_ID: terminalId,
        SPOOL_SOCKET: broker.socketPath,
        SPOOL_HOOK_SCRIPT: hookScriptPath,
        SPOOL_MCP_SCRIPT: context.asAbsolutePath('out/mcp.js'),
        SPOOL_STORAGE: storageDir,
      },
      iconPath: new vscode.ThemeIcon('sparkle'),
    });
  const runClaude = (session: Session, ...args: string[]) => {
    // Run claude through the user's shell so it gets their normal PATH and profile.
    // --mcp-config adds Spool's server to the user's own; it takes several files, so it goes last.
    const claudeArgs = ['--settings', settingsPath, ...args, '--mcp-config', mcpConfigPath];
    session.terminal?.sendText(`claude ${claudeArgs.map(shellQuote).join(' ')}`);
    session.terminal?.show();
  };

  /** Thread-title actions get a comment thread; the same actions on a sidebar row get the comment. */
  type CommentTarget = vscode.CommentThread | CodeComment;
  const commentOf = (target: CommentTarget) => ('startLine' in target ? target : threads.commentFor(target));
  let lastRevealedReply: string | undefined;

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

    // Comments. Send, Queue and More are the buttons under a new thread's input box; with no
    // current session, Send and Queue ask for one. Cancelling a pick leaves the input as it is.
    vscode.commands.registerCommand('spool.sendComment', async (reply: vscode.CommentReply) => {
      const session = threads.queueTarget ?? (await pickSession(reply.thread.uri.fsPath, store));
      if (session) {
        await send(session, [await threads.create(reply, session)]);
      }
    }),
    vscode.commands.registerCommand('spool.queueComment', async (reply: vscode.CommentReply) => {
      const session = threads.queueTarget ?? (await pickSession(reply.thread.uri.fsPath, store));
      if (session) {
        await threads.create(reply, session);
      }
    }),
    vscode.commands.registerCommand('spool.moreComment', async (reply: vscode.CommentReply) => {
      const file = reply.thread.uri.fsPath;
      const destination = await pickDestination(file, store, threads.queueTarget);
      if (destination?.kind === 'session') {
        await threads.create(reply, destination.session);
      } else if (destination?.kind === 'draft') {
        await threads.create(reply, undefined);
      } else if (destination?.kind === 'new') {
        const terminalId = randomUUID();
        const name = nameFromPrompt(reply.text);
        const session = store.create(terminalId, destination.dir, (n) => openTerminal(terminalId, n, destination.dir), name);
        await startWithComment(session, reply);
      } else if (destination?.kind === 'branch') {
        const parent = destination.parent ?? (await pickBranchParent(file, store));
        if (!parent?.claudeSessionId) {
          return;
        }
        const terminalId = randomUUID();
        const cwd = parent.cwd ?? parent.launchDir;
        const name = nameFromPrompt(`Branch: ${reply.text}`);
        const thread = store.branch(parent, terminalId, (n) => openTerminal(terminalId, n, cwd), name);
        await startWithComment(thread, reply, '--resume', parent.claudeSessionId, '--fork-session');
      }
    }),
    vscode.commands.registerCommand('spool.queueDraft', async (target: CommentTarget) => {
      const comment = commentOf(target);
      const session = comment && (await pickSession(comment.file, store));
      if (comment && session) {
        comments.queue(comment, session.id);
      }
    }),
    vscode.commands.registerCommand('spool.resolveComment', (target: CommentTarget) => {
      const comment = commentOf(target);
      if (comment) {
        comments.setResolved(comment, true);
      }
    }),
    vscode.commands.registerCommand('spool.reopenComment', (target: CommentTarget) => {
      const comment = commentOf(target);
      if (comment) {
        comments.setResolved(comment, false);
      }
    }),
    vscode.commands.registerCommand('spool.deleteComment', (target: CommentTarget) => {
      const comment = commentOf(target);
      if (comment) {
        comments.delete(comment);
      }
    }),
    // Reply and Reply Later are the buttons under an existing thread's reply box.
    vscode.commands.registerCommand('spool.replyComment', async (reply: vscode.CommentReply) => {
      const comment = threads.reply(reply);
      const session = store.all.find((s) => s.id === comment?.sessionId);
      if (comment && session?.terminal && session.status !== 'exited') {
        await send(session, [comment]);
      } else {
        vscode.window.showInformationMessage("The comment's session isn't running here; the reply is queued on it.");
      }
    }),
    vscode.commands.registerCommand('spool.replyCommentLater', (reply: vscode.CommentReply) => {
      threads.reply(reply);
    }),
    // From a comment's row in the sidebar.
    vscode.commands.registerCommand('spool.openComment', (comment: CodeComment) => threads.reveal(comment)),
    vscode.commands.registerCommand('spool.sendQueuedComment', async (comment: CodeComment) => {
      const session = store.all.find((s) => s.id === comment.sessionId);
      if (session?.terminal && session.status !== 'exited') {
        await send(session, [comment]);
      } else {
        vscode.window.showInformationMessage("The comment's session isn't running in this window.");
      }
    }),
    vscode.commands.registerCommand('spool.nextReply', async () => {
      const replied = comments.all
        .filter((comment) => comment.status === 'replied')
        .sort((a, b) => (a.replies.at(-1)?.at ?? 0) - (b.replies.at(-1)?.at ?? 0));
      if (!replied.length) {
        vscode.window.showInformationMessage('No replies waiting.');
        return;
      }
      // Oldest reply first; after the last one shown, go round again.
      const index = replied.findIndex((comment) => comment.id === lastRevealedReply);
      const next = replied[(index + 1) % replied.length];
      lastRevealedReply = next.id;
      await threads.reveal(next);
      const element = treeProvider.elementFor(next);
      if (element && view.visible) {
        await view.reveal(element, { select: true, focus: false });
      }
    }),
    vscode.commands.registerCommand('spool.sendComments', (session: Session) =>
      send(session, comments.queuedOn(session.id)),
    ),
    // Opens the comment input on the selection; VS Code asks which extension if several offer comments.
    vscode.commands.registerCommand('spool.commentOnSelection', () =>
      vscode.commands.executeCommand('workbench.action.addComment'),
    ),
  );

  const treeProvider = new SessionTreeProvider(store, comments);
  const view = vscode.window.createTreeView('spool.sessions', { treeDataProvider: treeProvider });
  context.subscriptions.push(
    view,
    watchNeedsInput(store, view),
    store.onDidChangeTerminalName(renameTabIfActive),
    // Keep the sidebar selection on the active session: when the active terminal changes,
    // and when a new session takes over the active terminal.
    vscode.window.onDidChangeActiveTerminal(selectActiveSession),
    store.onDidTakeOverTerminal(() => selectActiveSession(vscode.window.activeTerminal)),
    // New comments are queued on the session you last looked at, in its terminal or here.
    vscode.window.onDidChangeActiveTerminal((terminal) => threads.setQueueTarget(store.findByTerminal(terminal))),
    store.onDidTakeOverTerminal((session) => threads.setQueueTarget(session)),
    view.onDidChangeSelection(({ selection }) => {
      const [element] = selection;
      if (element && isSession(element)) {
        threads.setQueueTarget(element);
      }
    }),
  );
  threads.setQueueTarget(store.findByTerminal(vscode.window.activeTerminal));

  // History: Claude conversations for the open folders that Spool isn't listing.
  const history = new HistoryTreeProvider(store, context.globalState);
  const historyView = vscode.window.createTreeView('spool.history', { treeDataProvider: history });
  history.setVisible(historyView.visible);
  context.subscriptions.push(
    history,
    historyView,
    historyView.onDidChangeVisibility(({ visible }) => history.setVisible(visible)),
    vscode.commands.registerCommand('spool.refreshHistory', () => history.refresh()),
    vscode.commands.registerCommand('spool.hideHistory', (conversation: Conversation) => history.hide(conversation)),
    // Adds it to the Sessions view and resumes it there; from then on it's an ordinary session.
    vscode.commands.registerCommand('spool.resumeHistory', async (conversation: Conversation) => {
      const running = history.runningProcess(conversation);
      if (running) {
        const choice = await vscode.window.showWarningMessage(
          `"${conversation.title}" is still running in another terminal (pid ${running.pid}).`,
          {
            modal: true,
            detail:
              'Two Claude processes writing one conversation would interleave it. Quit it there first, or branch it instead.',
          },
          'Resume Anyway',
        );
        if (choice !== 'Resume Anyway') {
          return;
        }
      }
      const session = store.adopt(
        conversation.id,
        conversation.cwd,
        conversation.title,
        conversation.titleSource === 'custom' ? 'user' : 'auto',
      );
      await vscode.commands.executeCommand('spool.resumeSession', session);
    }),
    // A new Spool session forked from it; the original stays in History.
    vscode.commands.registerCommand('spool.branchHistory', (conversation: Conversation) => {
      const terminalId = randomUUID();
      const name = nameFromPrompt(`Branch: ${conversation.title}`);
      const session = store.create(terminalId, conversation.cwd, (n) => openTerminal(terminalId, n, conversation.cwd), name);
      runClaude(session, '--resume', conversation.id, '--fork-session');
    }),
  );

  /** Tells a session about comments queued on it; it reads them with Spool's MCP tools. */
  async function send(session: Session, toSend: CodeComment[]): Promise<void> {
    if (!toSend.length || !session.terminal) {
      return;
    }
    comments.markSent(toSend);
    await typeIntoClaude(session.terminal, commentsPrompt(toSend.length));
  }

  /**
   * Starts Claude in a session just created for a comment, with the prompt about it as the
   * first message: passed on the command line, so nothing is typed into the TUI.
   */
  async function startWithComment(session: Session, reply: vscode.CommentReply, ...args: string[]): Promise<void> {
    const comment = await threads.create(reply, session);
    comments.markSent([comment]);
    runClaude(session, ...args, commentsPrompt(1));
  }

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

function commentsPrompt(count: number): string {
  const comments = count === 1 ? 'a code comment' : `${count} code comments`;
  return `Spool: you have ${comments} from me. Read them with the spool get_comments tool and reply to each.`;
}

/**
 * Types one line into a session's Claude prompt and submits it. Enter is sent separately:
 * arriving in the same burst as the text, Claude can take it as part of a paste (a newline)
 * rather than a submit. If Claude is busy, it queues the message.
 */
async function typeIntoClaude(terminal: vscode.Terminal, line: string): Promise<void> {
  terminal.sendText(line, false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  terminal.sendText('\r', false);
}

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
