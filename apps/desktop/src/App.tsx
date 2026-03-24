import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ActivitySquare,
  BookOpen,
  CalendarClock,
  ChevronDown,
  HandCoins,
  KeyRound,
  LayoutDashboard,
  Lock,
  Plus,
  RefreshCcw,
  ShieldAlert,
  SlidersHorizontal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AccessGate } from './components/AccessGate';
import { ErrorSheet } from './components/ErrorSheet';
import { SkeletonTable } from './components/Skeleton';
import { StatusPill } from './components/StatusPill';
import {
  useDashboardData,
  useDutiesData,
  useHealthData,
  useIncidentsData,
  useRewardsData,
} from './hooks/useDashboardData';
import { useTheme } from './hooks/useTheme';
import {
  clearAuthProfile,
  loadAuthProfile,
  normalizeAutoLockMinutes,
  saveAuthProfile,
} from './lib/auth';
import { api, ApiError } from './lib/api';
import { logUi } from './lib/logger';
import {
  daemonDefaultPaths,
  daemonRuntimeStatus,
  ensureDaemonRunning,
  getDesktopLogsPath,
  isTauriRuntime,
  loadDaemonLaunchSettings,
  lockAndShowGateWindow,
  restartManagedDaemon,
  saveDaemonLaunchSettings,
  stopManagedDaemon,
  type DaemonEnsureResult,
  type DaemonLaunchSettings,
  type DaemonRuntimeStatus,
} from './lib/tauri';
import { getSafeQueryParam } from './lib/query';
import { DashboardPage } from './pages/DashboardPage';
import { DutiesPage } from './pages/DutiesPage';
import { HealthPage } from './pages/HealthPage';
import { IncidentsPage } from './pages/IncidentsPage';
import { KeyManagementPage } from './pages/KeyManagementPage';
import { OperationsPage } from './pages/OperationsPage';
import { RewardsPage } from './pages/RewardsPage';
import { SettingsPage } from './pages/SettingsPage';
import type { DashboardPayload, ErrorSheetPayload, Incident } from './types';

const HelpCenter = lazy(() => import('./components/HelpCenter'));

type AppTab =
  | 'dashboard'
  | 'duties'
  | 'rewards'
  | 'operations'
  | 'keymanager'
  | 'health'
  | 'incidents'
  | 'settings'
  | 'help';

type TabMeta = {
  id: AppTab;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
};

const tabs: TabMeta[] = [
  {
    id: 'dashboard',
    label: 'Overview',
    eyebrow: 'Core Monitor',
    title: 'Validator Operations Dashboard',
    description: 'The dashboard is scoped to the validator selected during onboarding.',
    icon: LayoutDashboard,
  },
  {
    id: 'duties',
    label: 'Duties',
    eyebrow: 'Schedule',
    title: 'Proposer & Sync Timeline',
    description:
      'Upcoming proposer/sync duties, countdown, and a safe maintenance window.',
    icon: CalendarClock,
  },
  {
    id: 'rewards',
    label: 'Rewards',
    eyebrow: 'Yield',
    title: 'Rewards & Reliability',
    description:
      'Balance deltas for 1h/24h/7d, missed attestation streaks, and withdrawal context.',
    icon: HandCoins,
  },
  {
    id: 'operations',
    label: 'Operations',
    eyebrow: 'Actions',
    title: 'Validator Action Center',
    description:
      'BLS 0x00→0x01 flow, signing/submission workflows, and validator keypair generation.',
    icon: Wrench,
  },
  {
    id: 'keymanager',
    label: 'Key Mgmt',
    eyebrow: 'Custody',
    title: 'Key Management & External Signer',
    description:
      'Keymanager API for keystore import/delete/list and remote signer registry per validator client.',
    icon: KeyRound,
  },
  {
    id: 'health',
    label: 'RPC Health',
    eyebrow: 'Diagnostics',
    title: 'Endpoint Reliability Matrix',
    description: 'Score, latency, and failover state for each RPC endpoint.',
    icon: ActivitySquare,
  },
  {
    id: 'incidents',
    label: 'Incidents',
    eyebrow: 'Ops Timeline',
    title: 'Incident Stream',
    description: 'Warning and critical incident history with technical details.',
    icon: ShieldAlert,
  },
  {
    id: 'settings',
    label: 'Settings',
    eyebrow: 'Security',
    title: 'Appearance & Access Control',
    description: '',
    icon: SlidersHorizontal,
  },
  {
    id: 'help',
    label: 'Help',
    eyebrow: 'Knowledge',
    title: 'Embedded Help Center',
    description: 'Quick explainers and troubleshooting for metrics and operational scenarios.',
    icon: BookOpen,
  },
];

const GLOBAL_INCIDENT_CODES = new Set([
  'CL_HEAD_UNAVAILABLE',
  'CL_HEAD_TIMEOUT',
  'EL_UNAVAILABLE',
  'EL_TIMEOUT',
  'RUNTIME_DEGRADED',
  'RUNTIME_INITIALIZING',
]);
const VALIDATOR_INCIDENT_PREFIXES = [
  'MISSED_',
  'VALIDATOR_',
  'PROPOSER_',
  'SYNC_',
  'WITHDRAWAL_',
  'EXIT_',
  'REWARD_',
  'DUTY_',
];

function normalizeError(error: unknown): ErrorSheetPayload {
  if (error instanceof ApiError) {
    return error.payload;
  }

  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  return {
    title: 'Beaconcha Tools System Error',
    message: 'An unexpected error occurred',
    error_code: 'UI_UNEXPECTED',
    technical_details: details,
    retryable: true,
    actions: ['retry', 'copy_diagnostics', 'open_logs', 'reset_state', 'report_issue'],
  };
}

function isValidatorScopedIncident(incident: Incident): boolean {
  if (GLOBAL_INCIDENT_CODES.has(incident.code)) {
    return false;
  }

  if (VALIDATOR_INCIDENT_PREFIXES.some((prefix) => incident.code.startsWith(prefix))) {
    return true;
  }

  const text = `${incident.message} ${incident.details}`.toLowerCase();
  return /validator\s+#?\d+/i.test(text) || /0x[a-f0-9]{24,}/i.test(text);
}

type IncidentSelection = {
  validatorIndex: number;
  validatorPubkey?: string | null;
};

function relatesToSelection(incident: Incident, selection: IncidentSelection) {
  if (!isValidatorScopedIncident(incident)) {
    return false;
  }

  const text = `${incident.message} ${incident.details}`.toLowerCase();
  const targetIndex = selection.validatorIndex.toString();
  const targetPubkey = selection.validatorPubkey?.toLowerCase();

  if (targetPubkey && text.includes(targetPubkey)) {
    return true;
  }

  const mentionedIndices = [...text.matchAll(/validator\s+#?(\d+)/gi)].map((match) => match[1]);
  if (mentionedIndices.length > 0) {
    return mentionedIndices.includes(targetIndex);
  }

  return true;
}

function filterIncidentsBySelection(
  incidents: Incident[] | undefined,
  selection: IncidentSelection | null
): Incident[] | undefined {
  if (!incidents) {
    return incidents;
  }

  const scoped = incidents.filter((incident) => isValidatorScopedIncident(incident));
  if (!selection) {
    return scoped;
  }
  return scoped.filter((incident) => relatesToSelection(incident, selection));
}

function daemonRuntimeFromEnsure(payload: DaemonEnsureResult): DaemonRuntimeStatus {
  return {
    running: payload.running,
    managed: payload.managed,
    pid: payload.pid,
    endpoint: payload.endpoint,
    executablePath: payload.executablePath,
    configPath: payload.configPath,
    lastError: payload.lastError,
  };
}

type DaemonActionResult = {
  ok: boolean;
  message: string;
};

function MainShell() {
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<AppTab>('dashboard');
  const [rewardsWindowHours, setRewardsWindowHours] = useState(24);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeValidatorIndex, setActiveValidatorIndex] = useState<number | null>(() => {
    const profile = loadAuthProfile();
    return profile?.validatorIndex ?? null;
  });
  const [validatorDraft, setValidatorDraft] = useState('');
  const [showAddValidatorModal, setShowAddValidatorModal] = useState(false);
  const [showValidatorSwitcher, setShowValidatorSwitcher] = useState(false);
  const [validatorModalError, setValidatorModalError] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [isSwitchingValidator, setIsSwitchingValidator] = useState(false);
  const [isImportingValidator, setIsImportingValidator] = useState(false);
  const validatorSwitchTimerRef = useRef<number | null>(null);
  const validatorSwitcherRef = useRef<HTMLDivElement | null>(null);
  const availableLogSignatureRef = useRef('');
  const [errorSheet, setErrorSheet] = useState<ErrorSheetPayload | null>(null);
  const [dismissedQueryErrorKey, setDismissedQueryErrorKey] = useState<string | null>(null);
  const [authProfile, setAuthProfile] = useState(() => loadAuthProfile());
  const [daemonSettings, setDaemonSettings] = useState<DaemonLaunchSettings>(() =>
    loadDaemonLaunchSettings()
  );
  const [daemonRuntime, setDaemonRuntime] = useState<DaemonRuntimeStatus | null>(null);
  const daemonAutostartTriggeredRef = useRef(false);
  const profileSyncRef = useRef<{
    key: string;
    inFlight: boolean;
    lastAttemptAt: number;
  }>({
    key: '',
    inFlight: false,
    lastAttemptAt: 0,
  });

  const dashboardQuery = useDashboardData();
  const dutiesQuery = useDutiesData(tab === 'duties');
  const rewardsQuery = useRewardsData(
    activeValidatorIndex,
    rewardsWindowHours,
    tab === 'rewards'
  );
  const healthQuery = useHealthData();
  const incidentsQuery = useIncidentsData();

  const incidentsQueryError = dashboardQuery.data ? null : incidentsQuery.error;
  const dutiesQueryError = tab === 'duties' ? dutiesQuery.error : null;
  const rewardsQueryError = tab === 'rewards' ? rewardsQuery.error : null;
  const queryError =
    dashboardQuery.error ??
    healthQuery.error ??
    incidentsQueryError ??
    dutiesQueryError ??
    rewardsQueryError ??
    null;
  const normalizedQueryError = queryError ? normalizeError(queryError) : null;
  const queryErrorKey = normalizedQueryError
    ? `${normalizedQueryError.error_code}:${normalizedQueryError.technical_details}`
    : null;
  const activeErrorSheet =
    errorSheet ??
    (normalizedQueryError && queryErrorKey !== dismissedQueryErrorKey ? normalizedQueryError : null);

  const refreshAll = useCallback(
    async (options?: { showButtonSpinner?: boolean }) => {
      const showButtonSpinner = options?.showButtonSpinner === true;
      const startedAt = performance.now();
      if (showButtonSpinner) {
        setIsManualRefreshing(true);
      }
      logUi('info', 'ui.refresh.start', 'refreshAll started', {
        showButtonSpinner,
      });

      try {
        await queryClient.invalidateQueries();
        await queryClient.refetchQueries({ type: 'active' });
        logUi('info', 'ui.refresh.done', 'refreshAll completed', {
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      } finally {
        if (showButtonSpinner) {
          setIsManualRefreshing(false);
        }
      }
    },
    [queryClient]
  );

  const waitForValidatorSnapshot = useCallback(
    async (validatorIndex: number, timeoutMs = 22_000) => {
      const startedAt = performance.now();
      let latest: DashboardPayload | null = null;

      while (performance.now() - startedAt < timeoutMs) {
        const dashboard = await api.getDashboard();
        latest = dashboard;
        queryClient.setQueryData(['dashboard'], dashboard);

        const snapshot = dashboard.validators.find(
          (entry) => entry.record.validator_index === validatorIndex
        );
        const tracked = dashboard.tracked_validator_indices.includes(validatorIndex);

        if (tracked && snapshot) {
          logUi('info', 'ui.validator.snapshot.ready', 'validator snapshot synchronized', {
            validatorIndex,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          return dashboard;
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 700);
        });
      }

      if (latest) {
        queryClient.setQueryData(['dashboard'], latest);
      }

      throw new Error(`Validator #${validatorIndex} did not synchronize in time.`);
    },
    [queryClient]
  );

  const retryMonitor = useCallback(async () => {
    try {
      await api.retry();
      await refreshAll();
    } catch (error) {
      setErrorSheet(normalizeError(error));
      throw error;
    }
  }, [refreshAll]);

  const resetState = useCallback(async () => {
    try {
      await api.resetState();
      await refreshAll();
    } catch (error) {
      setErrorSheet(normalizeError(error));
      throw error;
    }
  }, [refreshAll]);

  const lockNow = useCallback(async () => {
    try {
      await lockAndShowGateWindow();
    } catch (error) {
      setErrorSheet(normalizeError(error));
    }
  }, []);

  const toDaemonActionError = useCallback(
    (error: unknown): DaemonActionResult => {
      const normalized = normalizeError(error);
      setErrorSheet(normalized);
      return {
        ok: false,
        message: `${normalized.message} (${normalized.error_code})`,
      };
    },
    []
  );

  const syncDaemonRuntime = useCallback(async () => {
    if (!isTauriRuntime()) {
      setDaemonRuntime(null);
      return null;
    }

    const runtime = await daemonRuntimeStatus();
    setDaemonRuntime(runtime);
    return runtime;
  }, []);

  const updateDaemonSettings = useCallback((settings: DaemonLaunchSettings) => {
    setDaemonSettings(settings);
    saveDaemonLaunchSettings(settings);
  }, []);

  const daemonStart = useCallback(async (): Promise<DaemonActionResult> => {
    if (!isTauriRuntime()) {
      return {
        ok: false,
        message: 'Tauri runtime is unavailable.',
      };
    }

    try {
      const ensured = await ensureDaemonRunning(daemonSettings);
      if (ensured) {
        const runtime = daemonRuntimeFromEnsure(ensured);
        setDaemonRuntime(runtime);
        return {
          ok: runtime.running,
          message: ensured.message,
        };
      }

      const runtime = await syncDaemonRuntime();
      return {
        ok: Boolean(runtime?.running),
        message: runtime?.running ? 'Daemon is reachable.' : 'Daemon is unreachable.',
      };
    } catch (error) {
      return toDaemonActionError(error);
    }
  }, [daemonSettings, syncDaemonRuntime, toDaemonActionError]);

  const daemonRestart = useCallback(async (): Promise<DaemonActionResult> => {
    if (!isTauriRuntime()) {
      return {
        ok: false,
        message: 'Tauri runtime is unavailable.',
      };
    }

    try {
      const ensured = await restartManagedDaemon(daemonSettings);
      if (ensured) {
        const runtime = daemonRuntimeFromEnsure(ensured);
        setDaemonRuntime(runtime);
        return {
          ok: runtime.running,
          message: ensured.message,
        };
      }

      const runtime = await syncDaemonRuntime();
      return {
        ok: Boolean(runtime?.running),
        message: runtime?.running ? 'Daemon is reachable after restart.' : 'Daemon is unreachable after restart.',
      };
    } catch (error) {
      return toDaemonActionError(error);
    }
  }, [daemonSettings, syncDaemonRuntime, toDaemonActionError]);

  const daemonStop = useCallback(async (): Promise<DaemonActionResult> => {
    if (!isTauriRuntime()) {
      return {
        ok: false,
        message: 'Tauri runtime is unavailable.',
      };
    }

    try {
      const runtime = await stopManagedDaemon();
      setDaemonRuntime(runtime);
      if (runtime?.running) {
        return {
          ok: true,
          message: 'Managed daemon stopped. External daemon is still reachable.',
        };
      }
      return {
        ok: true,
        message: 'Daemon stopped.',
      };
    } catch (error) {
      return toDaemonActionError(error);
    }
  }, [toDaemonActionError]);

  const daemonRefreshStatus = useCallback(async (): Promise<DaemonActionResult> => {
    try {
      const runtime = await syncDaemonRuntime();
      return {
        ok: Boolean(runtime?.running),
        message: runtime?.running ? 'Daemon is reachable.' : 'Daemon is unreachable.',
      };
    } catch (error) {
      return toDaemonActionError(error);
    }
  }, [syncDaemonRuntime, toDaemonActionError]);

  const switchValidator = useCallback(
    (nextIndex: number) => {
      if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex === activeValidatorIndex) {
        return;
      }

      const startedAt = performance.now();
      logUi('info', 'ui.validator.switch.start', 'switch active validator', {
        from: activeValidatorIndex,
        to: nextIndex,
      });
      setIsSwitchingValidator(true);
      setActiveValidatorIndex(nextIndex);

      // Warm up rewards query for smoother visual switch without full-app refetch stalls.
      void queryClient
        .prefetchQuery({
          queryKey: ['rewards', nextIndex, rewardsWindowHours],
          queryFn: () => api.getRewards(nextIndex, rewardsWindowHours),
        })
        .then(() => {
          logUi('info', 'ui.validator.switch.prefetch_done', 'rewards prefetch done', {
            validatorIndex: nextIndex,
          });
        })
        .catch((error) => {
          logUi('warn', 'ui.validator.switch.prefetch_failed', 'rewards prefetch failed', {
            validatorIndex: nextIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      if (validatorSwitchTimerRef.current !== null) {
        window.clearTimeout(validatorSwitchTimerRef.current);
      }
      validatorSwitchTimerRef.current = window.setTimeout(() => {
        setIsSwitchingValidator(false);
        logUi('info', 'ui.validator.switch.done', 'switch visual state done', {
          to: nextIndex,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        validatorSwitchTimerRef.current = null;
      }, 220);
    },
    [activeValidatorIndex, queryClient, rewardsWindowHours]
  );

  const importValidatorFromInput = useCallback(async (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) {
      setValidatorModalError('Enter validator index or pubkey.');
      return;
    }

    setIsImportingValidator(true);
    setValidatorModalError(null);
    const startedAt = performance.now();
    logUi('info', 'ui.validator.import.start', 'import validator from runtime panel', {
      input,
    });
    try {
      let resolvedIndex: number | null = null;
      let importId = input;

      try {
        const resolved = await api.resolveValidator(input);
        resolvedIndex = resolved.index;
        importId = String(resolved.index);
      } catch {
        if (/^\d+$/.test(input)) {
          resolvedIndex = Number.parseInt(input, 10);
        }
      }

      await api.importValidator({
        id: importId,
        label: `Imported Validator ${importId}`,
        node: 'Imported',
        cluster: 'Imported',
        operator: 'Beaconcha Tools Local',
      });

      await api.retry();
      if (resolvedIndex !== null) {
        await waitForValidatorSnapshot(resolvedIndex);
      }
      await refreshAll();

      if (resolvedIndex !== null) {
        setActiveValidatorIndex(resolvedIndex);
      }
      setValidatorDraft('');
      setShowAddValidatorModal(false);
      setShowValidatorSwitcher(false);
      setValidatorModalError(null);
      logUi('info', 'ui.validator.import.done', 'validator imported', {
        input,
        resolvedIndex,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      logUi('error', 'ui.validator.import.failed', 'validator import failed', {
        input,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      setValidatorModalError(error instanceof Error ? error.message : 'Failed to import validator.');
      setErrorSheet(normalizeError(error));
    } finally {
      setIsImportingValidator(false);
    }
  }, [refreshAll, waitForValidatorSnapshot]);

  const openAddValidatorModal = useCallback(() => {
    setValidatorModalError(null);
    setShowValidatorSwitcher(false);
    setShowAddValidatorModal(true);
  }, []);

  const closeAddValidatorModal = useCallback(() => {
    if (isImportingValidator) {
      return;
    }
    setShowAddValidatorModal(false);
    setValidatorModalError(null);
    setValidatorDraft('');
  }, [isImportingValidator]);

  useEffect(() => {
    const syncProfile = () => {
      setAuthProfile(loadAuthProfile());
    };

    window.addEventListener('focus', syncProfile);
    window.addEventListener('storage', syncProfile);
    return () => {
      window.removeEventListener('focus', syncProfile);
      window.removeEventListener('storage', syncProfile);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (validatorSwitchTimerRef.current !== null) {
        window.clearTimeout(validatorSwitchTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showAddValidatorModal) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAddValidatorModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [showAddValidatorModal, closeAddValidatorModal]);

  useEffect(() => {
    if (!showValidatorSwitcher) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (validatorSwitcherRef.current?.contains(target)) {
        return;
      }
      setShowValidatorSwitcher(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowValidatorSwitcher(false);
      }
    };

    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [showValidatorSwitcher]);

  useEffect(() => {
    if (!authProfile || !isTauriRuntime()) {
      return;
    }

    const timeoutMs = normalizeAutoLockMinutes(authProfile.autoLockMinutes) * 60_000;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        void lockNow();
      }, timeoutMs);
    };

    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'scroll',
    ];

    for (const event of events) {
      window.addEventListener(event, arm);
    }

    arm();

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      for (const event of events) {
        window.removeEventListener(event, arm);
      }
    };
  }, [authProfile, lockNow]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const defaults = await daemonDefaultPaths();
        if (!cancelled && defaults) {
          setDaemonSettings((current) => ({
            ...current,
            executablePath: current.executablePath || defaults.executablePath || '',
            configPath: current.configPath || defaults.configPath || '',
          }));
        }
      } catch (error) {
        logUi('warn', 'ui.daemon.defaults_failed', 'failed to resolve daemon defaults', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const runtime = await daemonRuntimeStatus();
        if (!cancelled) {
          setDaemonRuntime(runtime);
        }
      } catch (error) {
        logUi('warn', 'ui.daemon.status_failed', 'failed to load daemon runtime status', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !daemonSettings.autostart || daemonAutostartTriggeredRef.current) {
      return;
    }

    daemonAutostartTriggeredRef.current = true;
    void daemonStart().then((result) => {
      if (!result.ok) {
        logUi('warn', 'ui.daemon.autostart_failed', 'daemon autostart failed', {
          message: result.message,
        });
      }
    });
  }, [daemonSettings.autostart, daemonStart]);

  useEffect(() => {
    if (!isTauriRuntime() || tab !== 'settings') {
      return;
    }

    let disposed = false;
    const refresh = async () => {
      try {
        const runtime = await daemonRuntimeStatus();
        if (!disposed) {
          setDaemonRuntime(runtime);
        }
      } catch (error) {
        if (!disposed) {
          logUi('warn', 'ui.daemon.status_poll_failed', 'daemon status poll failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [tab]);

  const dashboardPayload = dashboardQuery.data;

  const availableValidatorIndices = useMemo(() => {
    const indices = new Set<number>();

    for (const index of dashboardPayload?.tracked_validator_indices ?? []) {
      indices.add(index);
    }

    for (const snapshot of dashboardPayload?.validators ?? []) {
      indices.add(snapshot.record.validator_index);
    }

    if (authProfile) {
      indices.add(authProfile.validatorIndex);
    }

    return [...indices].sort((a, b) => a - b);
  }, [dashboardPayload?.tracked_validator_indices, dashboardPayload?.validators, authProfile]);

  useEffect(() => {
    if (!availableValidatorIndices.length) {
      if (activeValidatorIndex !== null && authProfile?.validatorIndex !== activeValidatorIndex) {
        setActiveValidatorIndex(authProfile?.validatorIndex ?? null);
      }
      return;
    }

    if (activeValidatorIndex === null) {
      setActiveValidatorIndex(authProfile?.validatorIndex ?? availableValidatorIndices[0]);
      return;
    }

      if (!availableValidatorIndices.includes(activeValidatorIndex)) {
      setActiveValidatorIndex(availableValidatorIndices[0]);
    }
  }, [availableValidatorIndices, activeValidatorIndex, authProfile]);

  useEffect(() => {
    const signature = `${activeValidatorIndex ?? 'none'}|${availableValidatorIndices.join(',')}`;
    if (signature === availableLogSignatureRef.current) {
      return;
    }
    availableLogSignatureRef.current = signature;

    logUi('debug', 'ui.validator.available', 'available validator indices updated', {
      indices: availableValidatorIndices,
      activeValidatorIndex,
    });
  }, [availableValidatorIndices, activeValidatorIndex]);

  const activeValidatorPubkey = useMemo(() => {
    if (activeValidatorIndex === null) {
      return authProfile?.validatorPubkey ?? null;
    }

    const fromPayload = dashboardPayload?.validators.find(
      (snapshot) => snapshot.record.validator_index === activeValidatorIndex
    );

    if (fromPayload) {
      return fromPayload.record.pubkey;
    }

    if (authProfile?.validatorIndex === activeValidatorIndex) {
      return authProfile.validatorPubkey;
    }

    return null;
  }, [activeValidatorIndex, authProfile, dashboardPayload?.validators]);

  const activeValidatorSnapshot = useMemo(() => {
    if (activeValidatorIndex === null) {
      return null;
    }

    return (
      dashboardPayload?.validators.find(
        (snapshot) => snapshot.record.validator_index === activeValidatorIndex
      ) ?? null
    );
  }, [activeValidatorIndex, dashboardPayload?.validators]);

  const activeValidatorHydrating = useMemo(() => {
    if (activeValidatorIndex === null || !dashboardPayload) {
      return false;
    }

    const tracked = dashboardPayload.tracked_validator_indices.includes(activeValidatorIndex);
    const hasSnapshot = dashboardPayload.validators.some(
      (snapshot) => snapshot.record.validator_index === activeValidatorIndex
    );

    return tracked && !hasSnapshot;
  }, [activeValidatorIndex, dashboardPayload]);

  useEffect(() => {
    if (!authProfile) {
      return;
    }

    const key = `${authProfile.validatorIndex}:${authProfile.validatorPubkey.toLowerCase()}`;
    const sourcePayload = dashboardQuery.data;
    const hasTrackedIndex = Boolean(
      sourcePayload?.tracked_validator_indices.includes(authProfile.validatorIndex)
    );
    const hasSnapshot = Boolean(
      sourcePayload?.validators.some(
        (validator) =>
          validator.record.validator_index === authProfile.validatorIndex ||
          validator.record.pubkey.toLowerCase() === authProfile.validatorPubkey.toLowerCase()
      )
    );

    if (hasTrackedIndex || hasSnapshot) {
      profileSyncRef.current = {
        key,
        inFlight: false,
        lastAttemptAt: Date.now(),
      };
      return;
    }

    if (profileSyncRef.current.inFlight) {
      return;
    }

    const now = Date.now();
    if (profileSyncRef.current.key === key && now - profileSyncRef.current.lastAttemptAt < 15_000) {
      return;
    }

    profileSyncRef.current = {
      key,
      inFlight: true,
      lastAttemptAt: now,
    };

    const importPayload = {
      id: String(authProfile.validatorIndex),
      label: `Primary Validator #${authProfile.validatorIndex}`,
      node: 'Primary',
      cluster: 'Primary',
      operator: 'Beaconcha Tools Local',
    };

    void (async () => {
      try {
        await api.importValidator(importPayload);
        await api.retry();
        await waitForValidatorSnapshot(authProfile.validatorIndex);
        await refreshAll();
      } catch (error) {
        const normalized = normalizeError(error);
        if (
          normalized.error_code !== 'DAEMON_UNREACHABLE' &&
          normalized.error_code !== 'DAEMON_TIMEOUT'
        ) {
          setErrorSheet(normalized);
        }
      } finally {
        profileSyncRef.current = {
          key,
          inFlight: false,
          lastAttemptAt: Date.now(),
        };
      }
    })();
  }, [authProfile, dashboardQuery.data, refreshAll, waitForValidatorSnapshot]);

  const incidentsPayload = useMemo(() => {
    const source = dashboardPayload?.incidents ?? incidentsQuery.data;
    if (activeValidatorIndex === null) {
      return filterIncidentsBySelection(source, null);
    }
    return filterIncidentsBySelection(source, {
      validatorIndex: activeValidatorIndex,
      validatorPubkey: activeValidatorPubkey,
    });
  }, [dashboardPayload?.incidents, incidentsQuery.data, activeValidatorIndex, activeValidatorPubkey]);

  const incidentsLoading = !dashboardPayload?.incidents && incidentsQuery.isLoading;

  const updatedAt = useMemo(() => {
    const timestamp = dashboardPayload?.runtime.updated_at;
    const nowDate = new Date(nowMs);

    if (!timestamp) {
      return {
        clock: nowDate.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }),
        date: nowDate.toLocaleDateString([], {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }),
        freshness: 'waiting',
      };
    }

    const syncDate = new Date(timestamp);
    const lagSeconds = Math.max(0, Math.floor((nowMs - syncDate.getTime()) / 1000));

    return {
      clock: nowDate.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
      date: nowDate.toLocaleDateString([], {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }),
      freshness: lagSeconds < 3 ? 'live sync' : `daemon ${lagSeconds}s ago`,
    };
  }, [dashboardPayload?.runtime.updated_at, nowMs]);

  const currentTab = tabs.find((entry) => entry.id === tab) ?? tabs[0];
  const runtimeMode = dashboardPayload?.runtime.mode ?? 'initializing';
  const uiRefreshPending = isManualRefreshing || isImportingValidator;
  const uiSwitchingPending = isSwitchingValidator && !uiRefreshPending;
  const activeValidatorStatus =
    activeValidatorSnapshot?.record.status.replace(/_/g, ' ') ?? null;
  const validatorRibbonMeta =
    activeValidatorIndex === null
      ? 'Not configured'
      : activeValidatorHydrating
        ? 'Syncing'
        : activeValidatorStatus ?? 'Ready';

  return (
    <div className="app-shell">
      <aside className="control-rail">
        <div className="brand-block">
          <img src="/icon.png" alt="Beaconcha Tools logo" className="brand-block__logo" />
          <div>
            <strong>BEACONCHA TOOLS</strong>
            <small>Validator command center</small>
          </div>
        </div>

        <nav className="rail-nav" aria-label="Main navigation">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? 'is-active' : ''}
              onClick={() => setTab(entry.id)}
            >
              <entry.icon size={16} strokeWidth={2} />
              <strong>{entry.label}</strong>
              <small>{entry.eyebrow}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section
        className={`workspace${uiRefreshPending ? ' is-refreshing' : ''}${uiSwitchingPending ? ' is-switching' : ''}`}
      >
        <header className="workspace-header">
          <div>
            <span>{currentTab.eyebrow}</span>
            <h1>{currentTab.title}</h1>
          </div>

          <div className="workspace-header__side">
            <div className="workspace-header__actions">
              <button
                type="button"
                className="workspace-header__icon-button"
                title="Refresh now"
                aria-label="Refresh now"
                onClick={() => void refreshAll({ showButtonSpinner: true })}
                disabled={isManualRefreshing || isImportingValidator}
              >
                <RefreshCcw
                  size={15}
                  className={isManualRefreshing || isImportingValidator ? 'icon-spin' : undefined}
                />
              </button>
              <button
                type="button"
                className="workspace-header__icon-button"
                title="Lock now"
                aria-label="Lock now"
                onClick={() => void lockNow()}
              >
                <Lock size={15} />
              </button>
            </div>

            <div className="workspace-header__meta">
              <small>Runtime sync</small>
              <strong>{updatedAt.clock}</strong>
              <span>{updatedAt.date}</span>
            </div>
          </div>
        </header>

        <section className="workspace-ribbon">
          <div className="workspace-ribbon__statusline">
            <div className="workspace-ribbon__metric workspace-ribbon__metric--runtime">
              <span
                className={`workspace-ribbon__signal-dot workspace-ribbon__signal-dot--${
                  runtimeMode === 'healthy'
                    ? 'healthy'
                    : runtimeMode === 'degraded'
                      ? 'degraded'
                      : 'critical'
                }`}
              />
              <StatusPill
                tone={
                  runtimeMode === 'healthy'
                    ? 'healthy'
                    : runtimeMode === 'degraded'
                      ? 'degraded'
                      : 'critical'
                }
                label={runtimeMode}
              />
            </div>

            <span className="workspace-ribbon__separator" aria-hidden="true" />

            <div className="workspace-ribbon__metric">
              <span className="workspace-ribbon__metric-label">Failover</span>
              <strong>{dashboardPayload?.runtime.rpc_failover_active ? 'Active' : 'Standby'}</strong>
            </div>

            <span className="workspace-ribbon__separator" aria-hidden="true" />

            <div className="workspace-ribbon__metric workspace-ribbon__metric--validator">
              <span className="workspace-ribbon__metric-label">Tracking</span>
              <strong>{activeValidatorIndex !== null ? `#${activeValidatorIndex}` : 'Not set'}</strong>
              <span className="workspace-ribbon__metric-note">{validatorRibbonMeta}</span>
            </div>
          </div>

          <div className="workspace-ribbon__picker" ref={validatorSwitcherRef}>
            <button
              type="button"
              className="workspace-ribbon__picker-trigger"
              aria-label="Switch validator"
              aria-expanded={showValidatorSwitcher}
              onClick={() => {
                if (!availableValidatorIndices.length) {
                  return;
                }
                setShowValidatorSwitcher((current) => !current);
              }}
              disabled={isSwitchingValidator || isImportingValidator || !availableValidatorIndices.length}
            >
              <span className="workspace-ribbon__picker-value">
                {activeValidatorIndex !== null ? `#${activeValidatorIndex}` : 'No validator'}
              </span>
              <ChevronDown
                size={14}
                className={showValidatorSwitcher ? 'workspace-ribbon__chevron is-open' : 'workspace-ribbon__chevron'}
              />
            </button>

            <button
              type="button"
              className="workspace-ribbon__picker-add"
              title="Add validator"
              aria-label="Add validator"
              onClick={openAddValidatorModal}
            >
              <Plus size={15} />
            </button>

            {showValidatorSwitcher && availableValidatorIndices.length > 0 ? (
              <div className="workspace-ribbon__switcher-menu" role="listbox" aria-label="Validator list">
                {availableValidatorIndices.map((index) => (
                  <button
                    key={index}
                    type="button"
                    className={index === activeValidatorIndex ? 'is-active' : undefined}
                    onClick={() => {
                      setShowValidatorSwitcher(false);
                      switchValidator(index);
                    }}
                  >
                    <strong>#{index}</strong>
                    <span>{index === activeValidatorIndex ? 'Current validator' : 'Select validator'}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <main
          className={`workspace-content${uiRefreshPending ? ' is-refreshing' : ''}${uiSwitchingPending ? ' is-switching' : ''}`}
          data-tab={tab}
        >
          {tab === 'dashboard' ? (
            <DashboardPage
              data={dashboardPayload}
              isLoading={dashboardQuery.isLoading}
              activeValidatorIndex={activeValidatorIndex}
              isActiveValidatorHydrating={activeValidatorHydrating}
            />
          ) : null}

          {tab === 'duties' ? (
            <DutiesPage
              duties={dutiesQuery.data}
              isLoading={dutiesQuery.isLoading}
              validatorIndex={activeValidatorIndex}
            />
          ) : null}

          {tab === 'rewards' ? (
            <RewardsPage
              rewards={rewardsQuery.data}
              isLoading={rewardsQuery.isLoading}
              windowHours={rewardsWindowHours}
              onWindowHoursChange={setRewardsWindowHours}
            />
          ) : null}

          {tab === 'operations' ? (
            <OperationsPage
              validatorIndex={activeValidatorIndex}
              validatorPubkey={activeValidatorPubkey}
              snapshot={activeValidatorSnapshot}
              currentEpoch={dashboardPayload?.chain_head?.epoch ?? null}
            />
          ) : null}

          {tab === 'keymanager' ? <KeyManagementPage /> : null}

          {tab === 'health' ? (
            <HealthPage endpoints={healthQuery.data} isLoading={healthQuery.isLoading} />
          ) : null}

          {tab === 'incidents' ? (
            <IncidentsPage incidents={incidentsPayload} isLoading={incidentsLoading} />
          ) : null}

          {tab === 'settings' ? (
            <SettingsPage
              onRetry={retryMonitor}
              onResetState={resetState}
              theme={theme}
              onThemeChange={setTheme}
              autoLockMinutes={authProfile?.autoLockMinutes ?? 10}
              onAutoLockChange={(minutes) => {
                const current = loadAuthProfile();
                if (!current) {
                  return;
                }

                const next = {
                  ...current,
                  autoLockMinutes: normalizeAutoLockMinutes(minutes),
                };

                saveAuthProfile(next);
                setAuthProfile(next);
              }}
              onLockNow={lockNow}
              onResetAccess={async () => {
                clearAuthProfile();
                setAuthProfile(null);
                await lockNow();
              }}
              daemonSettings={daemonSettings}
              onDaemonSettingsChange={updateDaemonSettings}
              daemonRuntime={daemonRuntime}
              onDaemonRefreshStatus={daemonRefreshStatus}
              onDaemonStart={daemonStart}
              onDaemonRestart={daemonRestart}
              onDaemonStop={daemonStop}
            />
          ) : null}

          {tab === 'help' ? (
            <Suspense fallback={<SkeletonTable rows={6} />}>
              <HelpCenter />
            </Suspense>
          ) : null}
        </main>
      </section>

      <ErrorSheet
        error={activeErrorSheet}
        onClose={() => {
          if (errorSheet) {
            setErrorSheet(null);
            return;
          }
          if (queryErrorKey) {
            setDismissedQueryErrorKey(queryErrorKey);
          }
        }}
        onRetry={() => {
          void retryMonitor();
        }}
        onCopyDiagnostics={() => {
          if (!activeErrorSheet) {
            return;
          }
          navigator.clipboard.writeText(JSON.stringify(activeErrorSheet, null, 2)).catch(() => null);
        }}
        onOpenLogs={() => {
          void api
            .getLogs()
            .then(async (result) => {
              const uiPath = await getDesktopLogsPath();
              const merged =
                uiPath && uiPath.length > 0
                  ? `daemon: ${result.path}\nui: ${uiPath}`
                  : `daemon: ${result.path}`;
              return navigator.clipboard.writeText(merged);
            })
            .catch((error) => setErrorSheet(normalizeError(error)));
        }}
        onResetState={() => {
          void resetState();
        }}
      />

      {showAddValidatorModal ? (
        <div
          className="validator-modal-backdrop"
          role="presentation"
          onClick={() => {
            closeAddValidatorModal();
          }}
        >
          <div
            className="validator-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="validator-modal-title"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="validator-modal__header">
              <div>
                <small>Validator Import</small>
                <h2 id="validator-modal-title">Add Validator</h2>
              </div>
              <button
                type="button"
                className="validator-modal__close"
                aria-label="Close add validator dialog"
                onClick={() => {
                  closeAddValidatorModal();
                }}
              >
                <X size={15} />
              </button>
            </div>

            <p>
              Enter a validator index or public key. Beaconcha Tools will resolve the target and
              sync it into the dashboard.
            </p>

            <label className="validator-modal__field">
              <span>Validator index or pubkey</span>
              <input
                value={validatorDraft}
                placeholder="12345 or 0x..."
                onChange={(event) => {
                  setValidatorModalError(null);
                  setValidatorDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void importValidatorFromInput(validatorDraft);
                  }
                }}
                autoFocus
              />
            </label>

            {validatorModalError ? (
              <p className="validator-modal__error">{validatorModalError}</p>
            ) : null}

            <div className="validator-modal__actions">
              <button
                type="button"
                className="validator-modal__secondary"
                onClick={() => {
                  closeAddValidatorModal();
                }}
                disabled={isImportingValidator}
              >
                Cancel
              </button>
              <button
                type="button"
                className="validator-modal__primary"
                onClick={() => {
                  void importValidatorFromInput(validatorDraft);
                }}
                disabled={isImportingValidator || !validatorDraft.trim()}
              >
                {isImportingValidator ? (
                  <>
                    <RefreshCcw size={15} className="icon-spin" />
                    Importing...
                  </>
                ) : (
                  'Add validator'
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const isGateView = getSafeQueryParam('view') === 'gate';

  return isGateView ? <AccessGate /> : <MainShell />;
}
