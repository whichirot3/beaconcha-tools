import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type {
  KeymanagerEndpointInfo,
  KeymanagerKeystoreRecord,
  KeymanagerMutationResult,
  KeymanagerRemoteKeyRecord,
} from '../types';

function shortHex(value: string, edge = 10) {
  if (!value) {
    return '—';
  }
  if (value.length <= edge * 2 + 2) {
    return value;
  }
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

function toError(error: unknown) {
  if (error instanceof ApiError) {
    return `${error.payload.message} (${error.payload.error_code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function splitLines(input: string) {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function KeyManagementPage() {
  const [endpoints, setEndpoints] = useState<KeymanagerEndpointInfo[]>([]);
  const [selectedEndpoint, setSelectedEndpoint] = useState('');
  const [keystores, setKeystores] = useState<KeymanagerKeystoreRecord[]>([]);
  const [remoteKeys, setRemoteKeys] = useState<KeymanagerRemoteKeyRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mutationResult, setMutationResult] = useState<KeymanagerMutationResult | null>(null);

  const [importKeystoresInput, setImportKeystoresInput] = useState('');
  const [importPasswordsInput, setImportPasswordsInput] = useState('');
  const [importSlashingInput, setImportSlashingInput] = useState('');
  const [deleteKeystoresInput, setDeleteKeystoresInput] = useState('');

  const [importRemoteKeysInput, setImportRemoteKeysInput] = useState('');
  const [deleteRemoteKeysInput, setDeleteRemoteKeysInput] = useState('');

  const endpointArg = useMemo(
    () => (selectedEndpoint.trim() ? selectedEndpoint.trim() : null),
    [selectedEndpoint]
  );

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [endpointList, keystoreList, remoteKeyList] = await Promise.all([
        api.getKeymanagerEndpoints(),
        api.getKeymanagerKeystores(endpointArg),
        api.getKeymanagerRemoteKeys(endpointArg),
      ]);
      setEndpoints(endpointList);
      setKeystores(keystoreList.records);
      setRemoteKeys(remoteKeyList.records);
    } catch (fetchError) {
      setError(toError(fetchError));
    } finally {
      setIsLoading(false);
    }
  }, [endpointArg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (
    action: () => Promise<KeymanagerMutationResult>,
    onSuccess?: () => void
  ) => {
    setIsBusy(true);
    setError(null);
    try {
      const result = await action();
      setMutationResult(result);
      if (onSuccess) {
        onSuccess();
      }
      await refresh();
    } catch (mutationError) {
      setError(toError(mutationError));
    } finally {
      setIsBusy(false);
    }
  };

  const submitImportKeystores = (event: FormEvent) => {
    event.preventDefault();
    const keystoresPayload = splitLines(importKeystoresInput);
    const passwordsPayload = splitLines(importPasswordsInput);

    void mutate(
      () =>
        api.importKeymanagerKeystores({
          endpoint: endpointArg,
          keystores: keystoresPayload,
          passwords: passwordsPayload,
          slashing_protection: importSlashingInput.trim() || null,
        }),
      () => {
        setImportKeystoresInput('');
        setImportPasswordsInput('');
      }
    );
  };

  const submitDeleteKeystores = (event: FormEvent) => {
    event.preventDefault();
    const pubkeys = splitLines(deleteKeystoresInput);
    void mutate(
      () =>
        api.deleteKeymanagerKeystores({
          endpoint: endpointArg,
          pubkeys,
        }),
      () => {
        setDeleteKeystoresInput('');
      }
    );
  };

  const submitImportRemoteKeys = (event: FormEvent) => {
    event.preventDefault();
    let remote_keys;
    try {
      remote_keys = splitLines(importRemoteKeysInput).map((line, index) => {
        const [pubkey, url] = line.split(',').map((part) => part.trim());
        if (!pubkey || !url) {
          throw new Error(
            `Line ${index + 1}: expected format "pubkey,url" for remote signer key.`
          );
        }
        return { pubkey, url, readonly: false };
      });
    } catch (parseError) {
      setError(toError(parseError));
      return;
    }

    void mutate(
      () =>
        api.importKeymanagerRemoteKeys({
          endpoint: endpointArg,
          remote_keys,
        }),
      () => {
        setImportRemoteKeysInput('');
      }
    );
  };

  const submitDeleteRemoteKeys = (event: FormEvent) => {
    event.preventDefault();
    const pubkeys = splitLines(deleteRemoteKeysInput);
    void mutate(
      () =>
        api.deleteKeymanagerRemoteKeys({
          endpoint: endpointArg,
          pubkeys,
        }),
      () => {
        setDeleteRemoteKeysInput('');
      }
    );
  };

  return (
    <section className="page keymanager-page">
      <section className="settings-card keymanager-toolbar">
        <label>
          Target endpoint
          <select
            value={selectedEndpoint}
            onChange={(event) => setSelectedEndpoint(event.target.value)}
            disabled={isBusy}
          >
            <option value="">All configured endpoints</option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.name} value={endpoint.name}>
                {endpoint.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void refresh()} disabled={isLoading || isBusy}>
          <RefreshCcw size={15} className={isLoading ? 'icon-spin' : undefined} />
          Refresh
        </button>
      </section>

      {error ? <p className="gate-inline-error">{error}</p> : null}

      {mutationResult ? (
        <section className="settings-card keymanager-result">
          <h3>Last action</h3>
          <small>{new Date(mutationResult.generated_at).toLocaleString()}</small>
          <ul>
            {mutationResult.applied.map((entry, index) => (
              <li key={`${entry.endpoint}-${entry.status}-${index}`}>
                <strong>{entry.endpoint}</strong> · {entry.status}
                {entry.message ? ` · ${entry.message}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="keymanager-grid">
        <section className="settings-card keymanager-card">
          <header>
            <h3>Keystores</h3>
            <p>Current validator keystores on selected validator clients.</p>
          </header>
          <div className="keymanager-table">
            <div className="keymanager-table__header">
              <span>Endpoint</span>
              <span>Pubkey</span>
              <span>Path</span>
              <span>Mode</span>
            </div>
            <div className="keymanager-table__body">
              {keystores.length ? (
                keystores.map((entry) => (
                  <div
                    key={`${entry.endpoint}-${entry.validating_pubkey}`}
                    className="keymanager-table__row"
                  >
                    <span>{entry.endpoint}</span>
                    <span title={entry.validating_pubkey}>{shortHex(entry.validating_pubkey, 12)}</span>
                    <span title={entry.derivation_path ?? undefined}>{entry.derivation_path ?? '—'}</span>
                    <span>{entry.readonly ? 'readonly' : 'managed'}</span>
                  </div>
                ))
              ) : (
                <div className="empty-state">Keystores not found</div>
              )}
            </div>
          </div>
        </section>

        <section className="settings-card keymanager-card">
          <header>
            <h3>Import/Delete keystores</h3>
            <p>Operations through the standard Keymanager API.</p>
          </header>
          <form className="ops-form" onSubmit={submitImportKeystores}>
            <label>
              Keystores (JSON, one per line)
              <textarea
                rows={5}
                value={importKeystoresInput}
                onChange={(event) => setImportKeystoresInput(event.target.value)}
              />
            </label>
            <label>
              Passwords (one per line)
              <textarea
                rows={3}
                value={importPasswordsInput}
                onChange={(event) => setImportPasswordsInput(event.target.value)}
              />
            </label>
            <label>
              Slashing protection interchange (optional JSON)
              <textarea
                rows={3}
                value={importSlashingInput}
                onChange={(event) => setImportSlashingInput(event.target.value)}
              />
            </label>
            <button type="submit" disabled={isBusy}>
              Import keystores
            </button>
          </form>

          <form className="ops-form" onSubmit={submitDeleteKeystores}>
            <label>
              Pubkeys to delete (one per line)
              <textarea
                rows={3}
                value={deleteKeystoresInput}
                onChange={(event) => setDeleteKeystoresInput(event.target.value)}
              />
            </label>
            <button type="submit" disabled={isBusy}>
              Delete keystores
            </button>
          </form>
        </section>

        <section className="settings-card keymanager-card">
          <header>
            <h3>Remote signer keys</h3>
            <p>External signer registry (Web3Signer/remote signer mode).</p>
          </header>
          <div className="keymanager-table">
            <div className="keymanager-table__header">
              <span>Endpoint</span>
              <span>Pubkey</span>
              <span>Signer URL</span>
              <span>Mode</span>
            </div>
            <div className="keymanager-table__body">
              {remoteKeys.length ? (
                remoteKeys.map((entry) => (
                  <div key={`${entry.endpoint}-${entry.pubkey}`} className="keymanager-table__row">
                    <span>{entry.endpoint}</span>
                    <span title={entry.pubkey}>{shortHex(entry.pubkey, 12)}</span>
                    <span title={entry.url}>{entry.url}</span>
                    <span>{entry.readonly ? 'readonly' : 'managed'}</span>
                  </div>
                ))
              ) : (
                <div className="empty-state">Remote signer keys not found</div>
              )}
            </div>
          </div>
        </section>

        <section className="settings-card keymanager-card">
          <header>
            <h3>Import/Delete remote keys</h3>
            <p>Import format: `pubkey,url` (one record per line).</p>
          </header>
          <form className="ops-form" onSubmit={submitImportRemoteKeys}>
            <label>
              Remote keys
              <textarea
                rows={4}
                value={importRemoteKeysInput}
                onChange={(event) => setImportRemoteKeysInput(event.target.value)}
                placeholder="0x...,http://127.0.0.1:9000"
              />
            </label>
            <button type="submit" disabled={isBusy}>
              Import remote keys
            </button>
          </form>

          <form className="ops-form" onSubmit={submitDeleteRemoteKeys}>
            <label>
              Pubkeys to delete (one per line)
              <textarea
                rows={3}
                value={deleteRemoteKeysInput}
                onChange={(event) => setDeleteRemoteKeysInput(event.target.value)}
              />
            </label>
            <button type="submit" disabled={isBusy}>
              Delete remote keys
            </button>
          </form>
        </section>
      </div>
    </section>
  );
}
