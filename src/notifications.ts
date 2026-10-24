import * as vscode from 'vscode';
import { Session, SessionStore } from './sessions';
import { SessionTreeElement } from './sessionTree';

/**
 * Surfaces sessions that need input: a count badge on the Sessions view (shown on the
 * activity bar icon) and a toast when a session starts waiting.
 */
export function watchNeedsInput(store: SessionStore, view: vscode.TreeView<SessionTreeElement>): vscode.Disposable {
  const updateBadge = () => {
    const count = store.all.filter((s) => s.status === 'needs-input').length;
    view.badge = count
      ? { value: count, tooltip: `${count} session${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} input` }
      : undefined;
  };

  return vscode.Disposable.from(
    store.onDidChange(updateBadge),
    store.onDidChangeStatus(({ session }) => {
      if (session.status !== 'needs-input' || isLookingAt(session)) {
        return;
      }
      vscode.window.showInformationMessage(`${session.name} needs your input`, 'Show').then((choice) => {
        if (choice === 'Show') {
          session.terminal?.show();
        }
      });
    }),
  );
}

function isLookingAt(session: Session): boolean {
  return vscode.window.state.focused && vscode.window.activeTerminal === session.terminal;
}
