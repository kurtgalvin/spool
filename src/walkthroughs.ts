import * as vscode from 'vscode';
import { CodeComment, CommentStore, Walkthrough } from './comments';
import { CommentThreads } from './commentThreads';

/** Set while you're in a walkthrough; enables the Previous / Next Step keybindings. */
const CONTEXT_KEY = 'spool.inWalkthrough';

/**
 * Moving through a walkthrough: one step's thread open at a time, the step you're on
 * remembered for the keyboard and the status bar ("‹ Step 3/5 ›").
 */
export class WalkthroughNavigator implements vscode.Disposable {
  /** The step opened last. */
  private current: string | undefined;
  private readonly previousItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly stepItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly comments: CommentStore,
    private readonly threads: CommentThreads,
    /** Selects the step in the sidebar. */
    private readonly select: (step: CodeComment) => void,
  ) {
    this.previousItem.text = '$(chevron-left)';
    this.previousItem.tooltip = 'Previous Step';
    this.previousItem.command = 'spool.previousStep';
    this.nextItem.text = '$(chevron-right)';
    this.nextItem.tooltip = 'Next Step';
    this.nextItem.command = 'spool.nextStep';
    this.stepItem.command = 'spool.leaveWalkthrough';
    this.disposables.push(
      this.previousItem,
      this.stepItem,
      this.nextItem,
      // Steps get added, removed and reordered; a walkthrough can be deleted.
      comments.onDidChange(() => this.update()),
    );
  }

  /** Opens a step: its file, with its thread expanded and the previous step's collapsed. */
  async show(step: CodeComment): Promise<void> {
    const previous = this.currentStep();
    if (previous && previous !== step) {
      this.threads.collapse(previous);
    }
    this.current = step.id;
    await this.threads.reveal(step);
    this.select(step);
    this.update();
  }

  /** Opens the first step you haven't opened, or step 1. */
  async start(walkthrough: Walkthrough): Promise<void> {
    const steps = this.comments.stepsOf(walkthrough);
    const step = steps.find((s) => s.unseen) ?? steps[0];
    if (step) {
      await this.show(step);
    }
  }

  /** From a step's thread or row, or (from the keyboard) the step you're on. */
  async move(offset: 1 | -1, from?: CodeComment): Promise<void> {
    const step = from ?? this.currentStep();
    const walkthrough = step && this.comments.walkthroughOf(step);
    if (!step || !walkthrough) {
      return;
    }
    const steps = this.comments.stepsOf(walkthrough);
    const next = steps[steps.indexOf(step) + offset];
    if (next) {
      // Moving from a thread you're reading: that's the one to collapse.
      this.current = step.id;
      await this.show(next);
    }
  }

  /** Hides the status bar until you open a step again. */
  leave(): void {
    this.current = undefined;
    this.update();
  }

  dispose(): void {
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private currentStep(): CodeComment | undefined {
    return this.comments.all.find((comment) => comment.id === this.current && comment.walkthroughId);
  }

  private update(): void {
    const step = this.currentStep();
    const walkthrough = step && this.comments.walkthroughOf(step);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, !!walkthrough);
    if (!step || !walkthrough) {
      this.current = undefined;
      this.previousItem.hide();
      this.stepItem.hide();
      this.nextItem.hide();
      return;
    }
    const steps = this.comments.stepsOf(walkthrough);
    const index = steps.indexOf(step);
    this.stepItem.text = `$(list-ordered) Step ${index + 1}/${steps.length}`;
    this.stepItem.tooltip = `${walkthrough.title}\nClick to leave the walkthrough`;
    this.stepItem.show();
    // Kept in place at the ends so the step count doesn't jump around; they just do nothing.
    this.previousItem.color = index > 0 ? undefined : new vscode.ThemeColor('disabledForeground');
    this.nextItem.color = index < steps.length - 1 ? undefined : new vscode.ThemeColor('disabledForeground');
    this.previousItem.show();
    this.nextItem.show();
  }
}
