export type SessionStatus = 'starting' | 'working' | 'needs-input' | 'idle' | 'exited';

/** Notification types that mean Claude is blocked until the user responds. */
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

/** Returns the status a session moves to after a hook event. */
export function nextStatus(current: SessionStatus, payload: Record<string, unknown>): SessionStatus {
  if (current === 'exited') {
    return current;
  }
  switch (payload.hook_event_name) {
    case 'SessionStart':
      // Also fires on /clear and resume, which can interrupt a turn.
      return 'idle';
    case 'UserPromptSubmit':
      return 'working';
    case 'PermissionRequest':
      // Fires as soon as the prompt appears; the matching Notification follows seconds later.
      return 'needs-input';
    case 'PostToolUse':
      // The only signal that a permission prompt was approved and Claude carried on.
      return current === 'needs-input' ? 'working' : current;
    case 'Notification':
      if (BLOCKING_NOTIFICATIONS.has(payload.notification_type as string)) {
        return 'needs-input';
      }
      // Interrupting a turn (Esc) fires no hook, so this is the only way to recover from
      // a stale 'working' status.
      return payload.notification_type === 'idle_prompt' ? 'idle' : current;
    case 'Stop':
      return 'idle';
    case 'SessionEnd':
      return 'exited';
    default:
      return current;
  }
}
