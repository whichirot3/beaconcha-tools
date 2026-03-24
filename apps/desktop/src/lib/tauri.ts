export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error('Tauri runtime is unavailable');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export type DesktopLogPayload = {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  context?: string;
  sessionId?: string;
};

export type DaemonLaunchSettings = {
  autostart: boolean;
  executablePath: string;
  configPath: string;
  startupTimeoutMs: number;
};

export type DaemonRuntimeStatus = {
  running: boolean;
  managed: boolean;
  pid: number | null;
  endpoint: string;
  executablePath: string | null;
  configPath: string | null;
  lastError: string | null;
};

export type DaemonEnsureResult = DaemonRuntimeStatus & {
  started: boolean;
  message: string;
};

export type DaemonDefaultPaths = {
  endpoint: string;
  executablePath: string | null;
  configPath: string | null;
};

const DAEMON_LAUNCH_SETTINGS_KEY = 'beaconcha_daemon_launch_settings_v1';

function sanitizeDaemonPath(path: string): string {
  const value = path.trim();
  if (!value) {
    return '';
  }

  // AppImage mount paths are ephemeral; persisting them breaks the next launch.
  if (value.includes('/.mount_') || value.startsWith('/tmp/.mount_')) {
    return '';
  }

  return value;
}

function normalizeDaemonSettings(
  settings: Partial<DaemonLaunchSettings> | null | undefined
): DaemonLaunchSettings {
  const autostart = settings?.autostart !== false;
  const executablePath = sanitizeDaemonPath(settings?.executablePath ?? '');
  const configPath = sanitizeDaemonPath(settings?.configPath ?? '');
  const startupTimeoutRaw =
    typeof settings?.startupTimeoutMs === 'number' && Number.isFinite(settings.startupTimeoutMs)
      ? settings.startupTimeoutMs
      : 16_000;
  const startupTimeoutMs = Math.min(90_000, Math.max(3_000, Math.round(startupTimeoutRaw)));

  return {
    autostart,
    executablePath,
    configPath,
    startupTimeoutMs,
  };
}

export function loadDaemonLaunchSettings(): DaemonLaunchSettings {
  try {
    const raw = localStorage.getItem(DAEMON_LAUNCH_SETTINGS_KEY);
    if (!raw) {
      return normalizeDaemonSettings(undefined);
    }
    return normalizeDaemonSettings(JSON.parse(raw) as Partial<DaemonLaunchSettings>);
  } catch {
    return normalizeDaemonSettings(undefined);
  }
}

export function saveDaemonLaunchSettings(settings: DaemonLaunchSettings): void {
  try {
    localStorage.setItem(
      DAEMON_LAUNCH_SETTINGS_KEY,
      JSON.stringify(normalizeDaemonSettings(settings))
    );
  } catch {
    // Ignore storage write failures in restricted runtime modes.
  }
}

export async function daemonDefaultPaths(): Promise<DaemonDefaultPaths | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  return invokeCommand<DaemonDefaultPaths>('daemon_default_paths');
}

export async function daemonRuntimeStatus(): Promise<DaemonRuntimeStatus | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  return invokeCommand<DaemonRuntimeStatus>('daemon_runtime_status');
}

export async function ensureDaemonRunning(
  input?: Partial<DaemonLaunchSettings>
): Promise<DaemonEnsureResult | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const normalized = normalizeDaemonSettings(input);
  return invokeCommand<DaemonEnsureResult>('ensure_daemon_running', {
    request: {
      executablePath: normalized.executablePath || null,
      configPath: normalized.configPath || null,
      startupTimeoutMs: normalized.startupTimeoutMs,
    },
  });
}

export async function stopManagedDaemon(): Promise<DaemonRuntimeStatus | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invokeCommand<DaemonRuntimeStatus>('stop_managed_daemon');
}

export async function restartManagedDaemon(
  input?: Partial<DaemonLaunchSettings>
): Promise<DaemonEnsureResult | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const normalized = normalizeDaemonSettings(input);
  return invokeCommand<DaemonEnsureResult>('restart_managed_daemon', {
    request: {
      executablePath: normalized.executablePath || null,
      configPath: normalized.configPath || null,
      startupTimeoutMs: normalized.startupTimeoutMs,
    },
  });
}

function navigateToMainFallback(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('mode');
    window.location.href = url.toString();
  } catch {
    window.location.href = '/';
  }
}

function navigateToGateFallback(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'gate');
    url.searchParams.set('mode', 'lock');
    window.location.href = url.toString();
  } catch {
    window.location.href = '/?view=gate&mode=lock';
  }
}

export async function unlockAndShowMainWindow(): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await invokeCommand<void>('unlock_and_show_main');
      return;
    } catch {
      navigateToMainFallback();
      return;
    }
  }

  navigateToMainFallback();
}

export async function lockAndShowGateWindow(): Promise<void> {
  if (isTauriRuntime()) {
    try {
      await invokeCommand<void>('lock_and_show_gate');
      return;
    } catch {
      navigateToGateFallback();
      return;
    }
  }

  navigateToGateFallback();
}

export async function closeCurrentWindow(): Promise<void> {
  if (isTauriRuntime()) {
    await invokeCommand<void>('close_gate_window');
    return;
  }

  window.close();
}

export async function writeDesktopLog(entry: DesktopLogPayload): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  await invokeCommand<void>('write_desktop_log', { entry });
}

export async function getDesktopLogsPath(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  try {
    return await invokeCommand<string>('desktop_logs_path');
  } catch {
    return null;
  }
}
