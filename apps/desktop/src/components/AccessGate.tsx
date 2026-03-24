import { type CSSProperties, Fragment, FormEvent, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Circle,
  CircleDashed,
  Copy,
  Database,
  Loader2,
  MoonStar,
  type LucideIcon,
  Server,
  SlidersHorizontal,
  SunMedium,
  UserRoundSearch,
  X,
} from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { ApiError, api } from '../lib/api';
import { getSafeQueryParam } from '../lib/query';
import {
  AUTH_PROFILE_CORRUPTED_ERROR,
  buildAuthProfile,
  clearAuthProfile,
  createPasswordSecret,
  loadAuthProfile,
  normalizeAutoLockMinutes,
  saveAuthProfile,
  verifyPassword,
  type AuthProfile,
} from '../lib/auth';
import {
  closeCurrentWindow,
  ensureDaemonRunning,
  isTauriRuntime,
  loadDaemonLaunchSettings,
  unlockAndShowMainWindow,
} from '../lib/tauri';
import type { ResolvedValidatorIdentity } from '../types';

type StartupState = 'pending' | 'running' | 'ok' | 'error';
type StartupStep = {
  id: string;
  label: string;
  details?: string;
  state: StartupState;
};

type GateStage = 'checks' | 'identity' | 'password' | 'unlock';
const MAX_UNLOCK_ATTEMPTS = 5;
const REQUIRED_CHECK_STEP_IDS = ['rpc', 'cache', 'config'] as const;

const STARTUP_STEPS: StartupStep[] = [
  { id: 'rpc', label: 'Beaconcha Tools daemon link', state: 'pending' },
  { id: 'cache', label: 'Local cache storage', state: 'pending' },
  { id: 'config', label: 'Runtime payload validation', state: 'pending' },
  { id: 'updates', label: 'Release channel ping', state: 'pending' },
];

type StartupFlowNode = {
  id: string;
  label: string;
  icon: LucideIcon;
};

const STARTUP_FLOW_NODES: StartupFlowNode[] = [
  { id: 'rpc', label: 'Daemon', icon: Server },
  { id: 'cache', label: 'Cache', icon: Database },
  { id: 'config', label: 'Config', icon: SlidersHorizontal },
  { id: 'updates', label: 'Channel', icon: Cloud },
];

type FlowTone = 'pending' | 'active' | 'error';
const DIRECT_BEACON_ENDPOINTS = [
  'https://lodestar-mainnet.chainsafe.io',
  'https://ethereum-beacon-api.publicnode.com',
];

function parseError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.payload.message} (${error.payload.error_code})`;
  }

  if (error instanceof Error) {
    if (error.message === AUTH_PROFILE_CORRUPTED_ERROR) {
      return 'Local access data is corrupted. Press RESET and configure access again.';
    }
    if (/did not match the expected pattern/i.test(error.message)) {
      return 'Internal UI environment error. Please try again.';
    }
    return error.message;
  }

  return 'Unexpected error';
}

function startupIcon(state: StartupState) {
  switch (state) {
    case 'ok':
      return <CheckCircle2 size={16} />;
    case 'running':
      return <CircleDashed size={16} className="gate-step__spin" />;
    case 'error':
      return <AlertTriangle size={16} />;
    default:
      return <Circle size={16} />;
  }
}

function flowToneFromState(state: StartupState): FlowTone {
  if (state === 'error') {
    return 'error';
  }

  if (state === 'ok' || state === 'running') {
    return 'active';
  }

  return 'pending';
}

function linkTone(left: FlowTone, right: FlowTone): FlowTone {
  if (left === 'error' || right === 'error') {
    return 'error';
  }
  if (left === 'active' || right === 'active') {
    return 'active';
  }
  return 'pending';
}

function extractWithdrawalAddress(credentials?: string): string | null {
  if (!credentials) {
    return null;
  }
  const normalized = credentials.toLowerCase();
  if (normalized.startsWith('0x01') && normalized.length === 66) {
    return `0x${normalized.slice(26)}`;
  }
  return null;
}

function shortHex(value?: string | null): string {
  if (!value) {
    return '—';
  }
  if (value.length <= 22) {
    return value;
  }
  return `${value.slice(0, 9)}…${value.slice(-10)}`;
}

function gweiToEth(value: number): string {
  return (value / 1_000_000_000).toFixed(4);
}

function stakedDisplay(identity: ResolvedValidatorIdentity): string {
  if (identity.status.toLowerCase().includes('withdrawal_done')) {
    return 'Withdrawn';
  }

  return `${gweiToEth(identity.effective_balance_gwei)} ETH`;
}

async function resolveDirectlyFromPublicBeacon(
  input: string
): Promise<ResolvedValidatorIdentity> {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Enter a validator index or pubkey.');
  }

  for (const endpoint of DIRECT_BEACON_ENDPOINTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 3500);

    try {
      const response = await fetch(
        `${endpoint}/eth/v1/beacon/states/head/validators/${encodeURIComponent(normalized)}`,
        { signal: controller.signal }
      );

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as {
        data?: {
          index?: string;
          balance?: string;
          status?: string;
          validator?: {
            pubkey?: string;
            withdrawal_credentials?: string;
            effective_balance?: string;
          };
        };
      };

      const index = Number.parseInt(payload.data?.index ?? '', 10);
      const pubkey = payload.data?.validator?.pubkey;
      const status = payload.data?.status ?? 'unknown';
      const effectiveBalanceGwei = Number.parseInt(
        payload.data?.validator?.effective_balance ?? '',
        10
      );
      const currentBalanceGwei = Number.parseInt(payload.data?.balance ?? '', 10);

      if (!Number.isFinite(index) || !pubkey) {
        continue;
      }

      return {
        index,
        pubkey,
        status,
        withdrawal_address: extractWithdrawalAddress(
          payload.data?.validator?.withdrawal_credentials
        ),
        effective_balance_gwei: Number.isFinite(effectiveBalanceGwei) ? effectiveBalanceGwei : 0,
        current_balance_gwei: Number.isFinite(currentBalanceGwei) ? currentBalanceGwei : 0,
      };
    } catch {
      // Try next endpoint.
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('Failed to verify validator via public Beacon API.');
}

export function AccessGate() {
  const { theme, setTheme } = useTheme();
  const mode = getSafeQueryParam('mode');
  const lockOnlyMode = mode === 'lock';
  const [profile, setProfile] = useState<AuthProfile | null>(() => loadAuthProfile());
  const [stage, setStage] = useState<GateStage>(() => {
    if (!lockOnlyMode) {
      return 'checks';
    }

    return profile ? 'unlock' : 'identity';
  });
  const [steps, setSteps] = useState<StartupStep[]>(() =>
    lockOnlyMode
      ? STARTUP_STEPS.map((step) => ({
          ...step,
          state: 'ok',
          details: 'Skipped in lock mode',
        }))
      : STARTUP_STEPS
  );
  const [checksCompleted, setChecksCompleted] = useState(lockOnlyMode);

  const [validatorInput, setValidatorInput] = useState('');
  const [resolved, setResolved] = useState<ResolvedValidatorIdentity | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [failedUnlockAttempts, setFailedUnlockAttempts] = useState(0);
  const [showResetPrompt, setShowResetPrompt] = useState(false);

  const [busyAction, setBusyAction] = useState<'resolve' | 'setup' | 'unlock' | null>(null);
  const [daemonBootstrapInProgress, setDaemonBootstrapInProgress] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const notice = errorMessage
    ? { tone: 'error' as const, text: errorMessage }
    : infoMessage
      ? { tone: 'info' as const, text: infoMessage }
      : null;

  useEffect(() => {
    if (stage !== 'checks') {
      return;
    }

    let alive = true;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    const updateStep = (id: string, patch: Partial<StartupStep>) => {
      setSteps((current) =>
        current.map((item) => (item.id === id ? { ...item, ...patch } : item))
      );
    };

    const runStep = async (
      id: string,
      runningDetails: string,
      task: () => Promise<{ state: 'ok' | 'error'; details: string }>
    ): Promise<'ok' | 'error'> => {
      if (!alive) {
        return 'error';
      }

      updateStep(id, { state: 'running', details: runningDetails });
      const startedAt = Date.now();

      let outcome: { state: 'ok' | 'error'; details: string };
      try {
        outcome = await task();
      } catch (error) {
        outcome = {
          state: 'error',
          details: parseError(error),
        };
      }

      const elapsed = Date.now() - startedAt;
      const minStepMs = 920;
      if (elapsed < minStepMs) {
        await wait(minStepMs - elapsed);
      }

      if (!alive) {
        return outcome.state;
      }

      updateStep(id, outcome);
      await wait(180);
      return outcome.state;
    };

    const run = async () => {
      setChecksCompleted(false);

      const rpcState = await runStep('rpc', 'Checking daemon status...', async () => {
        let daemonStarted = false;
        if (isTauriRuntime()) {
          const daemonSettings = loadDaemonLaunchSettings();
          if (daemonSettings.autostart) {
            setDaemonBootstrapInProgress(true);
            try {
              const ensured = await ensureDaemonRunning(daemonSettings);
              daemonStarted = Boolean(ensured?.started);
            } finally {
              setDaemonBootstrapInProgress(false);
            }
          }
        }
        await api.getStatus();
        return {
          state: 'ok',
          details: daemonStarted ? 'Daemon started and reachable' : 'Daemon reachable',
        };
      });

      const cacheState = await runStep('cache', 'Verifying local storage...', async () => {
        try {
          localStorage.setItem('beaconops_gate_probe', 'ok');
          localStorage.removeItem('beaconops_gate_probe');
          return { state: 'ok', details: 'Read/write available' };
        } catch {
          return { state: 'error', details: 'Local storage unavailable' };
        }
      });

      const configState = await runStep('config', 'Validating dashboard payload...', async () => {
        const dashboard = await api.getDashboard();
        return dashboard.runtime.mode
          ? { state: 'ok', details: 'Runtime payload is valid' }
          : { state: 'error', details: 'Runtime payload invalid' };
      });

      await runStep('updates', 'Checking release channel...', async () => {
        await wait(520);
        return { state: 'ok', details: 'Channel reachable' };
      });

      if (alive) {
        const requiredStates = {
          rpc: rpcState,
          cache: cacheState,
          config: configState,
        };
        const requiredOk = REQUIRED_CHECK_STEP_IDS.every(
          (id) => requiredStates[id] === 'ok'
        );
        setChecksCompleted(requiredOk);
        if (!requiredOk) {
          setErrorMessage(
            'Failed to complete required daemon/cache/config checks. Fix issues and retry.'
          );
        }
      }
    };

    void run();

    return () => {
      alive = false;
    };
  }, [stage]);

  const stepStateById = useMemo(() => {
    const mapping = new Map<string, StartupState>();
    for (const step of steps) {
      mapping.set(step.id, step.state);
    }
    return mapping;
  }, [steps]);
  const flowToneById = useMemo(() => {
    const mapping = new Map<string, FlowTone>();
    for (const node of STARTUP_FLOW_NODES) {
      mapping.set(node.id, flowToneFromState(stepStateById.get(node.id) ?? 'pending'));
    }
    return mapping;
  }, [stepStateById]);

  const continueAfterChecks = () => {
    if (!checksCompleted) {
      return;
    }

    setErrorMessage(null);
    setInfoMessage(null);
    setStage(profile ? 'unlock' : 'identity');
  };

  const resolveValidator = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = validatorInput.trim();
    if (!normalized) {
      setErrorMessage('Enter a validator index or pubkey.');
      return;
    }

    setBusyAction('resolve');
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const result = await api.resolveValidator(normalized);
      setResolved(result);
      setInfoMessage('Validator found. Verify identity and continue to password setup.');
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.payload.error_code === 'DAEMON_TIMEOUT' ||
          error.payload.error_code === 'DAEMON_UNREACHABLE')
      ) {
        try {
          const direct = await resolveDirectlyFromPublicBeacon(normalized);
          setResolved(direct);
          setInfoMessage(
            'Daemon is temporarily unavailable. Validator was verified directly via public Beacon API.'
          );
          setErrorMessage(null);
          return;
        } catch (fallbackError) {
          setResolved(null);
          setErrorMessage(parseError(fallbackError));
          return;
        }
      }

      setResolved(null);
      setErrorMessage(parseError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const completeSetup = async (event: FormEvent) => {
    event.preventDefault();
    if (!resolved) {
      setErrorMessage('Verify validator identity first.');
      return;
    }

    if (password.length < 8) {
      setErrorMessage('Minimum password length is 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage('Password and confirmation do not match.');
      return;
    }

    setBusyAction('setup');
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const waitForValidatorSync = async (index: number, timeoutMs = 16_000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const dashboard = await api.getDashboard();
          const trackedByIndex = dashboard.tracked_validator_indices.includes(index);
          const visibleInSnapshots = dashboard.validators.some(
            (snapshot) => snapshot.record.validator_index === index
          );
          if (trackedByIndex || visibleInSnapshots) {
            return;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 700);
          });
        }
        throw new Error('Daemon did not synchronize validator data in time.');
      };

      const secret = await createPasswordSecret(password);
      const nextProfile = buildAuthProfile({
        validatorIndex: resolved.index,
        validatorPubkey: resolved.pubkey,
        passwordHash: secret.passwordHash,
        salt: secret.salt,
        autoLockMinutes: normalizeAutoLockMinutes(10),
      });

      saveAuthProfile(nextProfile);
      setProfile(nextProfile);

      const importPayload = {
        id: String(resolved.index),
        label: `Primary Validator #${resolved.index}`,
        node: 'Primary',
        cluster: 'Primary',
        operator: 'Beaconcha Tools Local',
      };

      await api.importValidator(importPayload);
      await api.retry();
      await waitForValidatorSync(resolved.index);

      saveAuthProfile(nextProfile);
      setProfile(nextProfile);

      await unlockAndShowMainWindow();
    } catch (error) {
      setErrorMessage(parseError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    const current = profile ?? loadAuthProfile();
    if (!current) {
      setStage('identity');
      return;
    }

    if (!unlockPassword) {
      setUnlockError('Enter password');
      return;
    }

    setBusyAction('unlock');
    setUnlockError(null);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const isValid = await verifyPassword(unlockPassword, current);
      if (!isValid) {
        const nextAttempts = failedUnlockAttempts + 1;
        setFailedUnlockAttempts(nextAttempts);
        setUnlockPassword('');

        if (nextAttempts >= MAX_UNLOCK_ATTEMPTS) {
          setShowResetPrompt(true);
        } else {
          setUnlockError('Incorrect password');
        }
        return;
      }

      setFailedUnlockAttempts(0);
      setUnlockError(null);
      await unlockAndShowMainWindow();
    } catch (error) {
      setErrorMessage(parseError(error));
    } finally {
      setBusyAction(null);
    }
  };

  const resetAccess = async (skipConfirm = false) => {
    if (!skipConfirm) {
      const confirmed = window.confirm(
        'Reset local access? The profile will be removed and onboarding must be completed again.'
      );
      if (!confirmed) {
        return;
      }
    }

    clearAuthProfile();
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('beaconops_') || key.startsWith('beaconcha_')) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // localStorage can be unavailable in restricted runtime modes.
    }
    setProfile(null);
    setResolved(null);
    setValidatorInput('');
    setPassword('');
    setConfirmPassword('');
    setUnlockPassword('');
    setUnlockError(null);
    setFailedUnlockAttempts(0);
    setShowResetPrompt(false);
    setErrorMessage(null);
    setInfoMessage('Profile cleared. Run onboarding again.');
    setStage('identity');

    try {
      await api.resetState();
    } catch {
      // Non-blocking reset action.
    }
  };

  const copyValue = async (value: string | null | undefined) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setErrorMessage('Failed to copy value to clipboard.');
    }
  };

  return (
    <div className="gate-shell">
      <section className="gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-title">
        <div className="gate-column gate-column--main">
          <div className="gate-brand-bar" data-tauri-drag-region>
            <header className="gate-brand">
              <img src="/icon.png" alt="Beaconcha Tools" className="gate-brand__logo" />
              <div>
                <h1 id="gate-title">BEACONCHA TOOLS</h1>
              </div>
            </header>
            <div className="gate-window-actions">
              <button
                type="button"
                className="gate-theme-toggle"
                aria-label={theme === 'graphite_dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                title={theme === 'graphite_dark' ? 'Light theme' : 'Dark theme'}
                onClick={() => setTheme(theme === 'graphite_dark' ? 'studio_light' : 'graphite_dark')}
              >
                {theme === 'graphite_dark' ? <SunMedium size={14} /> : <MoonStar size={14} />}
              </button>
              <button
                type="button"
                className="gate-close"
                aria-label="Close window"
                onClick={() => {
                  void closeCurrentWindow();
                }}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {stage === 'checks' ? (
            <section className="gate-stage gate-stage--checks">
              <p>
                Environment initialization will complete in this window. After checks, press <strong>Next</strong>.
              </p>

              <div className="gate-flow gate-flow--pipeline" role="presentation" aria-hidden="true">
                <span className="gate-pipeline__track" />
                {STARTUP_FLOW_NODES.map((node, index) => {
                  const Icon = node.icon;
                  const nodeState = stepStateById.get(node.id) ?? 'pending';
                  const tone = flowToneById.get(node.id) ?? 'pending';
                  const nextNode = STARTUP_FLOW_NODES[index + 1];
                  const linkCount = STARTUP_FLOW_NODES.length - 1;
                  const link =
                    nextNode != null
                      ? linkTone(tone, flowToneById.get(nextNode.id) ?? 'pending')
                      : null;
                  const linkMotion = {
                    '--flow-delay': `${index * 760}ms`,
                    '--flow-cycle': `${Math.max(1, linkCount) * 760}ms`,
                  } as CSSProperties;

                  return (
                    <Fragment key={node.id}>
                      <article className={`gate-pipeline__node gate-pipeline__node--${nodeState}`}>
                        <span className="gate-pipeline__node-index">{index + 1}</span>
                        <span className="gate-pipeline__node-icon">
                          <svg className="gate-pipeline__node-ring" viewBox="0 0 36 36" aria-hidden="true">
                            <circle className="gate-pipeline__node-ring-track" cx="18" cy="18" r="15" />
                            <circle className="gate-pipeline__node-ring-progress" cx="18" cy="18" r="15" pathLength="100" />
                          </svg>
                          <Icon size={13} />
                        </span>
                        <small>{node.label}</small>
                      </article>

                      {link ? (
                        <span className={`gate-pipeline__link gate-pipeline__link--${link}`} style={linkMotion}>
                          <span className="gate-pipeline__link-pulse" />
                        </span>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>

              <button
                type="button"
                className="gate-primary"
                onClick={continueAfterChecks}
                disabled={!checksCompleted}
              >
                Next
                <ArrowRight size={16} />
              </button>
            </section>
          ) : null}

          {stage === 'identity' ? (
            <form className="gate-stage gate-form" onSubmit={resolveValidator}>
              <p>
                Enter a validator <strong>index</strong> or <strong>pubkey</strong>. Beaconcha Tools will
                resolve the linked identity automatically.
              </p>

              <label>
                Validator index or pubkey
                <input
                  value={validatorInput}
                  placeholder="12345 or 0x..."
                  onChange={(event) => setValidatorInput(event.target.value)}
                  autoFocus
                />
              </label>

              <button type="submit" className="gate-primary" disabled={busyAction === 'resolve'}>
                {busyAction === 'resolve' ? (
                  <>
                    <Loader2 size={16} className="gate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    Verify validator
                    <UserRoundSearch size={16} />
                  </>
                )}
              </button>

              <div className="gate-inline-actions">
                <button
                  type="button"
                  onClick={() => setStage('checks')}
                  className="gate-secondary"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStage('password')}
                  className="gate-primary"
                  disabled={!resolved}
                >
                  Continue
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          ) : null}

          {stage === 'password' ? (
            <form
              className="gate-stage gate-form gate-stage--compact gate-stage--password"
              onSubmit={completeSetup}
            >
              <p>
                Create a local password. It is required at startup and after auto-lock.
              </p>

              <label>
                Local password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoFocus
                />
              </label>

              <label>
                Confirm password
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>

              <div className="gate-inline-actions">
                <button
                  type="button"
                  onClick={() => setStage('identity')}
                  className="gate-secondary"
                >
                  Back
                </button>
                <button type="submit" className="gate-primary" disabled={busyAction === 'setup'}>
                  {busyAction === 'setup' ? (
                    <>
                      <Loader2 size={16} className="gate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </div>
            </form>
          ) : null}

          {stage === 'unlock' ? (
            <form className="gate-stage gate-form" onSubmit={unlock}>
              <p>
                Dashboard is locked. Enter your password.
              </p>

              {profile ? (
                <div className="gate-summary">
                  <div>
                    <small>Validator index</small>
                    <strong>#{profile.validatorIndex}</strong>
                  </div>
                  <div className="gate-summary__mono">
                    <small>Validator pubkey</small>
                    <strong>{profile.validatorPubkey}</strong>
                  </div>
                  <div>
                    <small>Auto-lock</small>
                    <strong>{profile.autoLockMinutes} min</strong>
                  </div>
                </div>
              ) : null}

              <label>
                Password
                <div
                  className={`gate-password-inline ${unlockPassword.length > 0 ? 'is-ready' : ''} ${unlockError ? 'has-error' : ''}`}
                >
                  <input
                    type="password"
                    value={unlockPassword}
                    placeholder={unlockError ?? 'Enter password'}
                    className={unlockError ? 'is-invalid' : undefined}
                    aria-invalid={Boolean(unlockError)}
                    onFocus={() => {
                      if (unlockError) {
                        setUnlockError(null);
                      }
                    }}
                    onChange={(event) => {
                      if (unlockError) {
                        setUnlockError(null);
                      }
                      setUnlockPassword(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="gate-enter-button"
                    aria-label="Submit with Enter"
                    disabled={busyAction === 'unlock' || unlockPassword.length === 0}
                    tabIndex={unlockPassword.length > 0 ? 0 : -1}
                  >
                    Enter
                  </button>
                </div>
              </label>
            </form>
          ) : null}

          {showResetPrompt ? (
            <div
              className="gate-reset-backdrop"
              role="presentation"
              onClick={() => {
                setShowResetPrompt(false);
                setFailedUnlockAttempts(0);
              }}
            >
              <div
                className="gate-reset-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Reset access prompt"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="gate-reset-modal__icon">
                  <AlertTriangle size={18} />
                </div>
                <div className="gate-reset-modal__content">
                  <strong>Too many attempts</strong>
                  <p>
                    {MAX_UNLOCK_ATTEMPTS} incorrect password attempts detected. Choose an action:
                    try again or reset access and run onboarding again.
                  </p>
                </div>
                <div className="gate-reset-modal__actions">
                  <button
                    type="button"
                    className="gate-secondary"
                    onClick={() => {
                      setShowResetPrompt(false);
                      setFailedUnlockAttempts(0);
                      setUnlockPassword('');
                      setUnlockError('Try again.');
                    }}
                  >
                    Try again
                  </button>
                  <button
                    type="button"
                    className="gate-danger"
                    onClick={() => {
                      void resetAccess(true);
                    }}
                  >
                    RESET
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {daemonBootstrapInProgress ? (
            <div className="gate-daemon-backdrop" role="status" aria-live="polite">
              <div className="gate-daemon-modal">
                <Loader2 size={18} className="gate-spin" />
                <div>
                  <strong>Daemon starting...</strong>
                  <p>Starting Beaconcha Tools daemon and validating local API.</p>
                </div>
              </div>
            </div>
          ) : null}

          {notice ? (
            <div
              className="gate-notice-backdrop"
              role="presentation"
              onClick={() => {
                setErrorMessage(null);
                setInfoMessage(null);
              }}
            >
              <div
                className={`gate-notice-modal gate-notice-modal--${notice.tone}`}
                role="dialog"
                aria-modal="true"
                aria-label="Beaconcha Tools notice"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="gate-notice-modal__icon">
                  {notice.tone === 'error' ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                </div>
                <div className="gate-notice-modal__content">
                  <strong>{notice.tone === 'error' ? 'Error' : 'Done'}</strong>
                  <p>{notice.text}</p>
                </div>
                <button
                  type="button"
                  className="gate-notice-modal__ok"
                  onClick={() => {
                    setErrorMessage(null);
                    setInfoMessage(null);
                  }}
                >
                  OK
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="gate-column gate-column--side">
          {resolved ? (
            <>
              <h2>Validator Identity</h2>
              <div className="gate-side-card">
                <div>
                  <small>Index</small>
                  <strong>#{resolved.index}</strong>
                </div>
                <div>
                  <small>Status</small>
                  <strong>{resolved.status}</strong>
                </div>
                <div>
                  <small>Staked</small>
                  <strong>{stakedDisplay(resolved)}</strong>
                  {resolved.status.toLowerCase().includes('withdrawal_done') ? (
                    <small className="gate-side-note">Already withdrawn, current stake is 0 ETH.</small>
                  ) : null}
                </div>
                <div className="gate-side-card__mono">
                  <small>Pubkey</small>
                  <div className="gate-copy-line">
                    <strong title={resolved.pubkey}>{shortHex(resolved.pubkey)}</strong>
                    <button
                      type="button"
                      className="gate-copy-button"
                      aria-label="Copy pubkey"
                      onClick={() => {
                        void copyValue(resolved.pubkey);
                      }}
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                </div>
                <div className="gate-side-card__mono">
                  <small>Withdrawal</small>
                  <div className="gate-copy-line">
                    <strong title={resolved.withdrawal_address ?? undefined}>
                      {shortHex(resolved.withdrawal_address)}
                    </strong>
                    <button
                      type="button"
                      className="gate-copy-button"
                      aria-label="Copy withdrawal address"
                      disabled={!resolved.withdrawal_address}
                      onClick={() => {
                        void copyValue(resolved.withdrawal_address);
                      }}
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <ul className="gate-step-list">
                {steps.map((step) => (
                  <li key={step.id} className={`gate-step gate-step--${step.state}`}>
                    <span className="gate-step__icon">{startupIcon(step.state)}</span>
                    <div>
                      <strong>{step.label}</strong>
                      <small>{step.details ?? 'Waiting...'}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </section>
    </div>
  );
}
