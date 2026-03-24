import type {
  BlsToExecutionBatchSignRequest,
  BlsToExecutionBatchSignResult,
  BlsToExecutionSignRequest,
  BlsToExecutionSignResult,
  DashboardPayload,
  DutiesPayload,
  EndpointHealth,
  ErrorSheetPayload,
  ExecutionActionSubmitRequest,
  ExecutionActionSubmitResult,
  KeymanagerDeleteKeystoresRequest,
  KeymanagerDeleteRemoteKeysRequest,
  KeymanagerEndpointInfo,
  KeymanagerImportKeystoresRequest,
  KeymanagerImportRemoteKeysRequest,
  KeymanagerListKeystoresResult,
  KeymanagerListRemoteKeysResult,
  KeymanagerMutationResult,
  ValidatorKeygenResult,
  Incident,
  ResolvedValidatorIdentity,
  RewardsPayload,
  ValidatorImportPayload,
  VoluntaryExitSignRequest,
  VoluntaryExitSignResult,
  ValidatorSnapshot,
} from '../types';
import { logUi } from './logger';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8742/api/v1';

function resolveBaseUrl(configured: string | undefined): string {
  const normalized = configured?.trim();
  if (!normalized) {
    return DEFAULT_BASE_URL;
  }

  try {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = pathname && pathname !== '/' ? pathname : '/api/v1';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return DEFAULT_BASE_URL;
  }
}

const BASE_URL = resolveBaseUrl(import.meta.env.VITE_DAEMON_BASE_URL);
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_DAEMON_TIMEOUT_MS ?? 8000);
let requestSequence = 0;

type RequestOptions = {
  timeoutMs?: number;
};

function isErrorSheetPayload(value: unknown): value is ErrorSheetPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<ErrorSheetPayload>;
  return (
    typeof payload.title === 'string' &&
    typeof payload.message === 'string' &&
    typeof payload.error_code === 'string' &&
    typeof payload.technical_details === 'string' &&
    typeof payload.retryable === 'boolean' &&
    Array.isArray(payload.actions)
  );
}

export class ApiError extends Error {
  payload: ErrorSheetPayload;

  constructor(payload: ErrorSheetPayload) {
    super(payload.message);
    this.payload = payload;
  }
}

async function request<T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const requestId = ++requestSequence;
  const startedAt = performance.now();
  const method = (init?.method ?? 'GET').toUpperCase();
  logUi('debug', 'api.request.start', `${method} ${path}`, {
    requestId,
    timeoutMs,
  });

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);

  if (init?.signal) {
    if (init.signal.aborted) {
      timeoutController.abort();
    } else {
      init.signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
    }
  }

  const headers = new Headers(init?.headers ?? undefined);
  if (init?.body !== undefined && init?.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: timeoutController.signal,
      headers,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const elapsedMs = Math.round(performance.now() - startedAt);

    const isTimeout =
      error instanceof DOMException && error.name === 'AbortError' && !init?.signal?.aborted;
    if (isTimeout) {
      logUi('warn', 'api.request.timeout', `${method} ${path}`, {
        requestId,
        elapsedMs,
        timeoutMs,
      });
      throw new ApiError({
        title: 'Beaconcha Tools Connection Timeout',
        message: 'Daemon did not respond in time',
        error_code: 'DAEMON_TIMEOUT',
        technical_details: `No response within ${timeoutMs}ms for ${BASE_URL}${path}`,
        retryable: true,
        actions: ['retry', 'copy_diagnostics', 'open_logs', 'reset_state', 'report_issue'],
      });
    }

    logUi('error', 'api.request.unreachable', `${method} ${path}`, {
      requestId,
      elapsedMs,
      error: error instanceof Error ? error.message : String(error),
    });

    throw new ApiError({
      title: 'Beaconcha Tools Connection Error',
      message: 'Failed to connect to daemon',
      error_code: 'DAEMON_UNREACHABLE',
      technical_details: error instanceof Error ? error.message : String(error),
      retryable: true,
      actions: ['retry', 'copy_diagnostics', 'open_logs', 'reset_state', 'report_issue'],
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const fallback: ErrorSheetPayload = {
      title: 'Beaconcha Tools System Error',
      message: 'Daemon request failed',
      error_code: `HTTP_${response.status}`,
      technical_details: response.statusText,
      retryable: true,
      actions: ['retry', 'copy_diagnostics', 'open_logs', 'reset_state', 'report_issue'],
    };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      logUi('warn', 'api.request.http_error_non_json', `${method} ${path}`, {
        requestId,
        elapsedMs,
        status: response.status,
      });
      throw new ApiError(fallback);
    }

    logUi('warn', 'api.request.http_error', `${method} ${path}`, {
      requestId,
      elapsedMs,
      status: response.status,
    });
    throw new ApiError(isErrorSheetPayload(payload) ? payload : fallback);
  }

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  if (response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  const rawBody = await response.text();
  const elapsedMs = Math.round(performance.now() - startedAt);
  logUi('info', 'api.request.success', `${method} ${path}`, {
    requestId,
    elapsedMs,
    status: response.status,
    bytes: rawBody.length,
  });

  if (!rawBody.trim()) {
    return undefined as T;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new ApiError({
      title: 'Beaconcha Tools System Error',
      message: 'Daemon returned an invalid response',
      error_code: 'DAEMON_INVALID_RESPONSE',
      technical_details: `Expected JSON payload for ${BASE_URL}${path}`,
      retryable: true,
      actions: ['retry', 'copy_diagnostics', 'open_logs', 'reset_state', 'report_issue'],
    });
  }
}

export const api = {
  getDashboard: () => request<DashboardPayload>('/dashboard', undefined, { timeoutMs: 12_000 }),
  getDuties: () => request<DutiesPayload>('/duties', undefined, { timeoutMs: 8_000 }),
  getRewards: (validatorIndex: number, windowHours = 24) =>
    request<RewardsPayload>(
      `/rewards/${validatorIndex}?window_hours=${encodeURIComponent(String(windowHours))}`,
      undefined,
      { timeoutMs: 8_000 }
    ),
  getValidators: () => request<ValidatorSnapshot[]>('/validators'),
  getIncidents: () => request<Incident[]>('/incidents'),
  getHealth: () => request<EndpointHealth[]>('/health'),
  resolveValidator: (id: string) =>
    request<ResolvedValidatorIdentity>(`/validators/resolve/${encodeURIComponent(id)}`, undefined, {
      timeoutMs: 4500,
    }),
  getStatus: () => request<Record<string, unknown>>('/status', undefined, { timeoutMs: 2500 }),
  getLogs: () => request<{ path: string }>('/logs'),
  retry: () => request<void>('/actions/retry', { method: 'POST' }),
  resetState: () => request<void>('/actions/reset-state', { method: 'POST' }),
  importValidator: (payload: ValidatorImportPayload) =>
    request<void>('/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, {
      timeoutMs: 12_000,
    }),
  signAndSubmitBlsChange: (payload: BlsToExecutionSignRequest) =>
    request<BlsToExecutionSignResult>(
      '/ops/bls-change/sign-submit',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: 15_000,
      }
    ),
  signAndSubmitBlsChangeBatch: (payload: BlsToExecutionBatchSignRequest) =>
    request<BlsToExecutionBatchSignResult>(
      '/ops/bls-change/batch-sign-submit',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: 25_000,
      }
    ),
  signAndSubmitConsensusExit: (payload: VoluntaryExitSignRequest) =>
    request<VoluntaryExitSignResult>(
      '/ops/consensus-exit/sign-submit',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: 18_000,
      }
    ),
  submitExecutionAction: (payload: ExecutionActionSubmitRequest) =>
    request<ExecutionActionSubmitResult>(
      '/ops/execution-action/submit',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: 18_000,
      }
    ),
  getKeymanagerEndpoints: () =>
    request<KeymanagerEndpointInfo[]>('/keymanager/endpoints', undefined, {
      timeoutMs: 8_000,
    }),
  getKeymanagerKeystores: (endpoint?: string | null) =>
    request<KeymanagerListKeystoresResult>(
      `/keymanager/keystores${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`,
      undefined,
      { timeoutMs: 10_000 }
    ),
  importKeymanagerKeystores: (payload: KeymanagerImportKeystoresRequest) =>
    request<KeymanagerMutationResult>(
      '/keymanager/keystores/import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      { timeoutMs: 20_000 }
    ),
  deleteKeymanagerKeystores: (payload: KeymanagerDeleteKeystoresRequest) =>
    request<KeymanagerMutationResult>(
      '/keymanager/keystores/delete',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      { timeoutMs: 20_000 }
    ),
  getKeymanagerRemoteKeys: (endpoint?: string | null) =>
    request<KeymanagerListRemoteKeysResult>(
      `/keymanager/remotekeys${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`,
      undefined,
      { timeoutMs: 10_000 }
    ),
  importKeymanagerRemoteKeys: (payload: KeymanagerImportRemoteKeysRequest) =>
    request<KeymanagerMutationResult>(
      '/keymanager/remotekeys/import',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      { timeoutMs: 20_000 }
    ),
  deleteKeymanagerRemoteKeys: (payload: KeymanagerDeleteRemoteKeysRequest) =>
    request<KeymanagerMutationResult>(
      '/keymanager/remotekeys/delete',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      { timeoutMs: 20_000 }
    ),
  generateValidatorKeys: (count = 1) =>
    request<ValidatorKeygenResult>(
      '/ops/validator-keys/generate',
      {
        method: 'POST',
        body: JSON.stringify({ count }),
      },
      {
        timeoutMs: 15_000,
      }
    ),
};

export { BASE_URL };
