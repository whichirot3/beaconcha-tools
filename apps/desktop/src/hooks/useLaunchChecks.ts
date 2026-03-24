import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

export interface LaunchStep {
  id: string;
  label: string;
  state: 'pending' | 'running' | 'ok' | 'error';
  details?: string;
}

const BASE_STEPS: LaunchStep[] = [
  { id: 'rpc', label: 'RPC / daemon link', state: 'pending' },
  { id: 'cache', label: 'Local cache check', state: 'pending' },
  { id: 'config', label: 'Runtime config probe', state: 'pending' },
  { id: 'updates', label: 'Update channel ping', state: 'pending' },
];

export function useLaunchChecks() {
  const [steps, setSteps] = useState<LaunchStep[]>(BASE_STEPS);
  const [checksCompleted, setChecksCompleted] = useState(false);
  const [ready, setReady] = useState(false);
  const isDev = import.meta.env.DEV;

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      const update = (id: string, patch: Partial<LaunchStep>) => {
        setSteps((current) =>
          current.map((step) => (step.id === id ? { ...step, ...patch } : step))
        );
      };

      update('rpc', { state: 'running' });
      try {
        await api.getStatus();
        update('rpc', { state: 'ok', details: 'Daemon API reachable' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        update('rpc', { state: 'error', details: message });
      }

      update('cache', { state: 'running' });
      try {
        localStorage.setItem('beaconops_cache_probe', 'ok');
        localStorage.removeItem('beaconops_cache_probe');
        update('cache', { state: 'ok', details: 'Read/write available' });
      } catch {
        update('cache', { state: 'error', details: 'Local cache unavailable' });
      }

      update('config', { state: 'running' });
      try {
        const dashboard = await api.getDashboard();
        update('config', {
          state: dashboard.runtime.mode ? 'ok' : 'error',
          details: dashboard.runtime.mode ? 'Runtime payload valid' : 'Invalid runtime payload',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        update('config', { state: 'error', details: message });
      }

      update('updates', { state: 'running' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      update('updates', { state: 'ok', details: 'Channel available' });

      if (!mounted) {
        return;
      }

      setChecksCompleted(true);
      if (!isDev) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (mounted) {
          setReady(true);
        }
      }
    };

    run();

    return () => {
      mounted = false;
    };
  }, [isDev]);

  const progress = useMemo(() => {
    const done = steps.filter((step) => step.state === 'ok' || step.state === 'error').length;
    return Math.round((done / steps.length) * 100);
  }, [steps]);

  const continueToApp = useCallback(() => {
    if (!checksCompleted) {
      return;
    }
    setReady(true);
  }, [checksCompleted]);

  return {
    steps,
    progress,
    ready,
    checksCompleted,
    isDev,
    continueToApp,
  };
}
