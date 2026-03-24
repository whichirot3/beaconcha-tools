import { isTauriRuntime, writeDesktopLog, type DesktopLogPayload } from './tauri';

type LogLevel = DesktopLogPayload['level'];

const SESSION_ID = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const MAX_CONTEXT_LEN = 3500;

let globalHandlersInstalled = false;

function formatContext(context: unknown): string | undefined {
  if (context === undefined || context === null) {
    return undefined;
  }

  if (typeof context === 'string') {
    return context.slice(0, MAX_CONTEXT_LEN);
  }

  try {
    return JSON.stringify(context).slice(0, MAX_CONTEXT_LEN);
  } catch {
    return String(context).slice(0, MAX_CONTEXT_LEN);
  }
}

export function logUi(level: LogLevel, scope: string, message: string, context?: unknown): void {
  const timestamp = new Date().toISOString();
  const serializedContext = formatContext(context);

  const consolePayload = {
    timestamp,
    scope,
    message,
    context: serializedContext,
  };

  if (level === 'error') {
    console.error('[BeaconchaTools]', consolePayload);
  } else if (level === 'warn') {
    console.warn('[BeaconchaTools]', consolePayload);
  } else if (level === 'debug') {
    console.debug('[BeaconchaTools]', consolePayload);
  } else {
    console.log('[BeaconchaTools]', consolePayload);
  }

  if (!isTauriRuntime()) {
    return;
  }

  void writeDesktopLog({
    timestamp,
    level,
    scope,
    message,
    context: serializedContext,
    sessionId: SESSION_ID,
  }).catch(() => undefined);
}

export function installGlobalUiErrorLogging(): void {
  if (globalHandlersInstalled || typeof window === 'undefined') {
    return;
  }

  globalHandlersInstalled = true;

  window.addEventListener('error', (event) => {
    logUi('error', 'window.error', event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logUi('error', 'window.unhandledrejection', 'Unhandled promise rejection', {
      reason:
        reason instanceof Error
          ? {
              name: reason.name,
              message: reason.message,
              stack: reason.stack,
            }
          : reason,
    });
  });
}
