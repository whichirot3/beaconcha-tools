import { FormEvent, useEffect, useState } from 'react';
import { KeyRound, Loader2, Palette, Play, RotateCw, ShieldAlert, Square } from 'lucide-react';
import type { Theme } from '../hooks/useTheme';
import type { DaemonLaunchSettings, DaemonRuntimeStatus } from '../lib/tauri';

type RuntimeActionResult = {
  ok: boolean;
  message: string;
};

type Props = {
  onRetry: () => Promise<void>;
  onResetState: () => Promise<void>;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  autoLockMinutes: number;
  onAutoLockChange: (minutes: number) => void;
  onLockNow: () => Promise<void>;
  onResetAccess: () => Promise<void>;
  daemonSettings: DaemonLaunchSettings;
  onDaemonSettingsChange: (settings: DaemonLaunchSettings) => void;
  daemonRuntime: DaemonRuntimeStatus | null;
  onDaemonRefreshStatus: () => Promise<RuntimeActionResult>;
  onDaemonStart: () => Promise<RuntimeActionResult>;
  onDaemonRestart: () => Promise<RuntimeActionResult>;
  onDaemonStop: () => Promise<RuntimeActionResult>;
};

export function SettingsPage({
  onRetry,
  onResetState,
  theme,
  onThemeChange,
  autoLockMinutes,
  onAutoLockChange,
  onLockNow,
  onResetAccess,
  daemonSettings,
  onDaemonSettingsChange,
  daemonRuntime,
  onDaemonRefreshStatus,
  onDaemonStart,
  onDaemonRestart,
  onDaemonStop,
}: Props) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [autoLockInput, setAutoLockInput] = useState(String(autoLockMinutes));
  const [daemonAutostart, setDaemonAutostart] = useState(daemonSettings.autostart);
  const [daemonExecutablePath, setDaemonExecutablePath] = useState(daemonSettings.executablePath);
  const [daemonConfigPath, setDaemonConfigPath] = useState(daemonSettings.configPath);
  const [daemonTimeoutMs, setDaemonTimeoutMs] = useState(String(daemonSettings.startupTimeoutMs));
  const [runtimeFeedback, setRuntimeFeedback] = useState<{
    tone: 'info' | 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    setAutoLockInput(String(autoLockMinutes));
  }, [autoLockMinutes]);

  useEffect(() => {
    setDaemonAutostart(daemonSettings.autostart);
    setDaemonExecutablePath(daemonSettings.executablePath);
    setDaemonConfigPath(daemonSettings.configPath);
    setDaemonTimeoutMs(String(daemonSettings.startupTimeoutMs));
  }, [daemonSettings]);

  const submitAutoLock = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number.parseInt(autoLockInput, 10);
    onAutoLockChange(Number.isFinite(parsed) ? parsed : autoLockMinutes);
    setSuccess('Auto-lock timeout updated.');
  };

  const submitDaemonSettings = (event: FormEvent) => {
    event.preventDefault();
    const timeout = Number.parseInt(daemonTimeoutMs, 10);
    const nextSettings: DaemonLaunchSettings = {
      autostart: daemonAutostart,
      executablePath: daemonExecutablePath.trim(),
      configPath: daemonConfigPath.trim(),
      startupTimeoutMs: Number.isFinite(timeout) ? timeout : daemonSettings.startupTimeoutMs,
    };
    onDaemonSettingsChange(nextSettings);
    setRuntimeFeedback({
      tone: 'success',
      text: 'Daemon launch settings saved.',
    });
  };

  const daemonReachable = daemonRuntime?.running ?? false;
  const daemonStatusLabel = daemonReachable ? 'ONLINE' : 'OFFLINE';

  const runRuntimeAction = async (params: {
    action: string;
    pending: string;
    task: () => Promise<RuntimeActionResult>;
  }) => {
    const { action, pending, task } = params;
    setBusyAction(action);
    setRuntimeFeedback({
      tone: 'info',
      text: pending,
    });
    try {
      const result = await task();
      setRuntimeFeedback({
        tone: result.ok ? 'success' : 'error',
        text: result.message,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeFeedback({
        tone: 'error',
        text: message,
      });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="page settings-page">
      <div className="settings-layout settings-layout--single">
        <section className="settings-card">
          <header>
            <h3>
              <ShieldAlert size={16} />
              Runtime actions
            </h3>
            <p>Daemon service actions for diagnostics and recovery.</p>
          </header>

          <div className="daemon-status-caption">
            <small>Daemon status</small>
            <strong className={daemonReachable ? 'is-online' : 'is-offline'}>
              {daemonStatusLabel}
            </strong>
          </div>

          {runtimeFeedback ? (
            <div className="runtime-feedback" data-tone={runtimeFeedback.tone}>
              {runtimeFeedback.text}
            </div>
          ) : null}

          <div className="daemon-status">
            <div>
              <small>Endpoint</small>
              <strong>{daemonRuntime?.endpoint ?? 'n/a'}</strong>
            </div>
            <div>
              <small>Reachable</small>
              <strong>{daemonRuntime?.running ? 'yes' : 'no'}</strong>
            </div>
            <div>
              <small>Managed by app</small>
              <strong>{daemonRuntime?.managed ? 'yes' : 'no'}</strong>
            </div>
            <div>
              <small>PID</small>
              <strong>{daemonRuntime?.pid ?? '—'}</strong>
            </div>
            <div>
              <small>Executable</small>
              <strong title={daemonRuntime?.executablePath ?? undefined}>
                {daemonRuntime?.executablePath ?? 'auto'}
              </strong>
            </div>
            <div>
              <small>Config</small>
              <strong title={daemonRuntime?.configPath ?? undefined}>
                {daemonRuntime?.configPath ?? 'auto'}
              </strong>
            </div>
          </div>

          <form className="autolock-form" onSubmit={submitDaemonSettings}>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={daemonAutostart}
                onChange={(event) => setDaemonAutostart(event.target.checked)}
              />
              <span>Start daemon automatically when the app launches</span>
            </label>

            <label>
              Daemon executable path (optional)
              <input
                value={daemonExecutablePath}
                onChange={(event) => setDaemonExecutablePath(event.target.value)}
                placeholder="auto-detect if empty"
              />
            </label>

            <label>
              Daemon config path (optional)
              <input
                value={daemonConfigPath}
                onChange={(event) => setDaemonConfigPath(event.target.value)}
                placeholder="auto-detect if empty"
              />
            </label>

            <label>
              Startup timeout (ms)
              <input
                type="number"
                min={3000}
                max={90000}
                value={daemonTimeoutMs}
                onChange={(event) => setDaemonTimeoutMs(event.target.value)}
              />
            </label>

            <button type="submit">Save daemon settings</button>
          </form>

          <div className="settings-actions settings-actions--inline">
            <button
              type="button"
              className={busyAction === 'daemon_start' ? 'is-pending' : undefined}
              onClick={() => {
                void runRuntimeAction({
                  action: 'daemon_start',
                  pending: 'Starting daemon...',
                  task: onDaemonStart,
                });
              }}
              disabled={busyAction === 'daemon_start'}
            >
              {busyAction === 'daemon_start' ? <Loader2 size={14} className="icon-spin" /> : <Play size={14} />}
              {busyAction === 'daemon_start' ? 'Starting...' : 'Start daemon'}
            </button>

            <button
              type="button"
              className={busyAction === 'daemon_restart' ? 'is-pending' : undefined}
              onClick={() => {
                void runRuntimeAction({
                  action: 'daemon_restart',
                  pending: 'Restarting daemon...',
                  task: onDaemonRestart,
                });
              }}
              disabled={busyAction === 'daemon_restart'}
            >
              {busyAction === 'daemon_restart' ? <Loader2 size={14} className="icon-spin" /> : <RotateCw size={14} />}
              {busyAction === 'daemon_restart' ? 'Restarting...' : 'Restart daemon'}
            </button>

            <button
              type="button"
              className={busyAction === 'daemon_stop' ? 'danger is-pending' : 'danger'}
              onClick={() => {
                void runRuntimeAction({
                  action: 'daemon_stop',
                  pending: 'Stopping managed daemon...',
                  task: onDaemonStop,
                });
              }}
              disabled={busyAction === 'daemon_stop'}
            >
              {busyAction === 'daemon_stop' ? <Loader2 size={14} className="icon-spin" /> : <Square size={14} />}
              {busyAction === 'daemon_stop' ? 'Stopping...' : 'Stop managed daemon'}
            </button>

            <button
              type="button"
              className={busyAction === 'daemon_refresh' ? 'is-pending' : undefined}
              onClick={() => {
                void runRuntimeAction({
                  action: 'daemon_refresh',
                  pending: 'Refreshing daemon status...',
                  task: onDaemonRefreshStatus,
                });
              }}
              disabled={busyAction === 'daemon_refresh'}
            >
              {busyAction === 'daemon_refresh' ? <Loader2 size={14} className="icon-spin" /> : <RotateCw size={14} />}
              {busyAction === 'daemon_refresh' ? 'Refreshing...' : 'Refresh daemon status'}
            </button>
          </div>

          <div className="settings-actions settings-actions--inline">
            <button
              type="button"
              className={busyAction === 'retry' ? 'is-pending' : undefined}
              onClick={() => {
                void runRuntimeAction({
                  action: 'retry',
                  pending: 'Running manual retry...',
                  task: async () => {
                    await onRetry();
                    return {
                      ok: true,
                      message: 'Manual retry completed.',
                    };
                  },
                });
              }}
              disabled={busyAction === 'retry'}
            >
              {busyAction === 'retry' ? <Loader2 size={14} className="icon-spin" /> : null}
              {busyAction === 'retry' ? 'Running...' : 'Manual retry'}
            </button>

            <button
              type="button"
              className={busyAction === 'reset_state' ? 'danger is-pending' : 'danger'}
              onClick={() => {
                void runRuntimeAction({
                  action: 'reset_state',
                  pending: 'Resetting daemon cache state...',
                  task: async () => {
                    await onResetState();
                    return {
                      ok: true,
                      message: 'Daemon cache state has been reset.',
                    };
                  },
                });
              }}
              disabled={busyAction === 'reset_state'}
            >
              {busyAction === 'reset_state' ? <Loader2 size={14} className="icon-spin" /> : null}
              {busyAction === 'reset_state' ? 'Resetting...' : 'Reset cache state'}
            </button>
          </div>
        </section>

        <section className="settings-card">
          <header>
            <h3>
              <Palette size={16} />
              Appearance
            </h3>
            <p>Light theme is enabled by default. Dark theme can be enabled manually.</p>
          </header>

          <div className="appearance-card__choices">
            <button
              type="button"
              className={theme === 'studio_light' ? 'is-active' : ''}
              onClick={() => onThemeChange('studio_light')}
            >
              Light (Default)
            </button>
            <button
              type="button"
              className={theme === 'graphite_dark' ? 'is-active' : ''}
              onClick={() => onThemeChange('graphite_dark')}
            >
              Dark
            </button>
          </div>
        </section>

        <section className="settings-card">
          <header>
            <h3>
              <KeyRound size={16} />
              Access lock
            </h3>
            <p>Local password is required on every launch and after inactivity timeout.</p>
          </header>

          <form className="autolock-form" onSubmit={submitAutoLock}>
            <label>
              Auto-lock timeout (minutes)
              <input
                type="number"
                min={1}
                max={240}
                value={autoLockInput}
                onChange={(event) => setAutoLockInput(event.target.value)}
              />
            </label>
            <button type="submit">Save timeout</button>
          </form>

          <div className="settings-actions settings-actions--inline">
            <button
              type="button"
              onClick={async () => {
                setBusyAction('lock');
                try {
                  await onLockNow();
                } finally {
                  setBusyAction(null);
                }
              }}
              disabled={busyAction === 'lock'}
            >
              {busyAction === 'lock' ? 'Locking...' : 'Lock now'}
            </button>

            <button
              type="button"
              className="danger"
              onClick={async () => {
                setBusyAction('reset_access');
                try {
                  await onResetAccess();
                } finally {
                  setBusyAction(null);
                }
              }}
              disabled={busyAction === 'reset_access'}
            >
              {busyAction === 'reset_access' ? 'Resetting...' : 'RESET access'}
            </button>
          </div>
        </section>
      </div>

      {success ? <p className="success-hint">{success}</p> : null}
    </section>
  );
}
