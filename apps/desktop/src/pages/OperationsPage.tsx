import { FormEvent, useEffect, useMemo, useState } from 'react';
import { KeyRound, LogOut, Send, Wrench } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { deriveInventory, formatEta } from '../lib/eligibility';
import type {
  BlsToExecutionBatchSignResult,
  BlsToExecutionSignResult,
  ExecutionActionSubmitResult,
  ExecutionActionType,
  VoluntaryExitSignResult,
  ValidatorKeygenResult,
  ValidatorSnapshot,
} from '../types';

type Props = {
  validatorIndex: number | null;
  validatorPubkey: string | null;
  snapshot: ValidatorSnapshot | null;
  currentEpoch: number | null;
};

function shortHex(value: string, edge = 12): string {
  if (!value) {
    return '—';
  }

  if (value.length <= edge * 2 + 2) {
    return value;
  }

  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.payload.technical_details?.trim();
    if (details && details !== error.payload.message) {
      return `${details} (${error.payload.error_code})`;
    }
    return `${error.payload.message} (${error.payload.error_code})`;
  }

  return error instanceof Error ? error.message : String(error);
}

function validateHexField(value: string, bytes: number, label: string): string | null {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (!normalized) {
    return `${label} is required.`;
  }
  if (normalized.length !== bytes * 2) {
    return `${label} must be ${bytes} bytes hex.`;
  }
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    return `${label} must be valid hex.`;
  }
  return null;
}

function parseBatchItems(input: string) {
  const rows = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return rows.map((row, index) => {
    const [validatorIndex, fromBlsPubkey, blsPrivateKey] = row.split(',').map((part) => part.trim());
    if (!validatorIndex || !fromBlsPubkey || !blsPrivateKey) {
      throw new Error(
        `Line ${index + 1}: expected format "validator_index,from_bls_pubkey,bls_private_key".`
      );
    }

    const parsedIndex = Number.parseInt(validatorIndex, 10);
    if (!Number.isFinite(parsedIndex) || parsedIndex < 0) {
      throw new Error(`Line ${index + 1}: validator_index must be an integer >= 0.`);
    }

    const pubkeyError = validateHexField(fromBlsPubkey, 48, `Line ${index + 1} from_bls_pubkey`);
    if (pubkeyError) {
      throw new Error(pubkeyError);
    }

    const privateKeyError = validateHexField(blsPrivateKey, 32, `Line ${index + 1} bls_private_key`);
    if (privateKeyError) {
      throw new Error(privateKeyError);
    }

    return {
      validator_index: parsedIndex,
      from_bls_pubkey: fromBlsPubkey,
      bls_private_key: blsPrivateKey,
    };
  });
}

const EXECUTION_ACTION_OPTIONS: Array<{ value: ExecutionActionType; label: string }> = [
  { value: 'convert_to_compounding', label: '0x01 -> 0x02 convert' },
  { value: 'consolidate', label: 'Consolidate' },
  { value: 'top_up', label: 'Top-up' },
  { value: 'full_exit', label: 'EL full exit' },
  { value: 'partial_withdraw', label: 'Manual partial withdraw' },
];

const EXECUTION_ACTION_PRECHECK = {
  convert_to_compounding: 'convert_0x01_to_0x02',
  consolidate: 'consolidate',
  top_up: 'top_up',
  full_exit: 'execution_exit',
  partial_withdraw: 'partial_withdraw',
} as const;

export function OperationsPage({ validatorIndex, validatorPubkey, snapshot, currentEpoch }: Props) {
  const [validatorIndexInput, setValidatorIndexInput] = useState(() =>
    validatorIndex !== null ? String(validatorIndex) : ''
  );
  const [fromPubkeyInput, setFromPubkeyInput] = useState(() => validatorPubkey ?? '');
  const [toExecutionAddressInput, setToExecutionAddressInput] = useState('');
  const [privateKeyInput, setPrivateKeyInput] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [signBusy, setSignBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signResult, setSignResult] = useState<BlsToExecutionSignResult | null>(null);

  const [batchToExecutionAddressInput, setBatchToExecutionAddressInput] = useState('');
  const [batchItemsInput, setBatchItemsInput] = useState('');
  const [batchDryRun, setBatchDryRun] = useState(true);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<BlsToExecutionBatchSignResult | null>(null);

  const [exitValidatorIndexInput, setExitValidatorIndexInput] = useState(() =>
    validatorIndex !== null ? String(validatorIndex) : ''
  );
  const [exitPubkeyInput, setExitPubkeyInput] = useState(() => validatorPubkey ?? '');
  const [exitPrivateKeyInput, setExitPrivateKeyInput] = useState('');
  const [exitEpochInput, setExitEpochInput] = useState('');
  const [exitDryRun, setExitDryRun] = useState(true);
  const [exitBusy, setExitBusy] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitResult, setExitResult] = useState<VoluntaryExitSignResult | null>(null);

  const [executionAction, setExecutionAction] =
    useState<ExecutionActionType>('convert_to_compounding');
  const [executionValidatorIndexInput, setExecutionValidatorIndexInput] = useState(() =>
    validatorIndex !== null ? String(validatorIndex) : ''
  );
  const [executionTargetIndexInput, setExecutionTargetIndexInput] = useState('');
  const [executionAmountInput, setExecutionAmountInput] = useState('');
  const [executionRawTxInput, setExecutionRawTxInput] = useState('');
  const [executionDryRun, setExecutionDryRun] = useState(true);
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionActionSubmitResult | null>(null);

  const [keyCountInput, setKeyCountInput] = useState('1');
  const [keygenBusy, setKeygenBusy] = useState(false);
  const [keygenError, setKeygenError] = useState<string | null>(null);
  const [keygenResult, setKeygenResult] = useState<ValidatorKeygenResult | null>(null);

  useEffect(() => {
    if (validatorIndex !== null) {
      setValidatorIndexInput(String(validatorIndex));
      setExitValidatorIndexInput(String(validatorIndex));
      setExecutionValidatorIndexInput(String(validatorIndex));
    }
  }, [validatorIndex]);

  useEffect(() => {
    if (validatorPubkey) {
      setFromPubkeyInput((current) => (current.trim() ? current : validatorPubkey));
      setExitPubkeyInput((current) => (current.trim() ? current : validatorPubkey));
    }
  }, [validatorPubkey]);

  const activeHint = useMemo(() => {
    if (validatorIndex === null) {
      return 'No active validator selected. Enter index manually.';
    }

    return `Active validator: #${validatorIndex}`;
  }, [validatorIndex]);
  const preflight = useMemo(
    () => (snapshot ? deriveInventory(snapshot, currentEpoch) : null),
    [snapshot, currentEpoch]
  );
  const executionLocalPreflight = useMemo(() => {
    const parsedIndex = Number.parseInt(executionValidatorIndexInput.trim(), 10);
    if (!preflight || validatorIndex === null || parsedIndex !== validatorIndex) {
      return null;
    }
    const actionId = EXECUTION_ACTION_PRECHECK[executionAction];
    return preflight.actions.find((action) => action.id === actionId) ?? null;
  }, [preflight, executionAction, executionValidatorIndexInput, validatorIndex]);

  const submitBlsChange = async (event: FormEvent) => {
    event.preventDefault();
    const parsedIndex = Number.parseInt(validatorIndexInput.trim(), 10);
    if (!Number.isFinite(parsedIndex) || parsedIndex < 0) {
      setSignError('Validator index must be an integer >= 0.');
      return;
    }

    const fromPubkeyError = validateHexField(fromPubkeyInput, 48, 'From BLS pubkey');
    if (fromPubkeyError) {
      setSignError(fromPubkeyError);
      return;
    }

    const executionAddressError = validateHexField(
      toExecutionAddressInput,
      20,
      'To execution address'
    );
    if (executionAddressError) {
      setSignError(executionAddressError);
      return;
    }

    const privateKeyError = validateHexField(privateKeyInput, 32, 'BLS private key');
    if (privateKeyError) {
      setSignError(privateKeyError);
      return;
    }

    setSignBusy(true);
    setSignError(null);
    setSignResult(null);

    try {
      const result = await api.signAndSubmitBlsChange({
        validator_index: parsedIndex,
        from_bls_pubkey: fromPubkeyInput.trim(),
        to_execution_address: toExecutionAddressInput.trim(),
        bls_private_key: privateKeyInput.trim(),
        dry_run: dryRun,
      });
      setSignResult(result);
      setPrivateKeyInput('');
    } catch (error) {
      setSignError(extractErrorMessage(error));
    } finally {
      setSignBusy(false);
    }
  };

  const submitBlsBatch = async (event: FormEvent) => {
    event.preventDefault();

    let items;
    try {
      items = parseBatchItems(batchItemsInput);
    } catch (error) {
      setBatchError(extractErrorMessage(error));
      return;
    }

    if (!items.length) {
      setBatchError('Add at least one row for the batch operation.');
      return;
    }

    const executionAddressError = validateHexField(
      batchToExecutionAddressInput,
      20,
      'To execution address'
    );
    if (executionAddressError) {
      setBatchError(executionAddressError);
      return;
    }

    setBatchBusy(true);
    setBatchError(null);
    setBatchResult(null);

    try {
      const result = await api.signAndSubmitBlsChangeBatch({
        to_execution_address: batchToExecutionAddressInput.trim(),
        items,
        dry_run: batchDryRun,
      });
      setBatchResult(result);
      setBatchItemsInput('');
    } catch (error) {
      setBatchError(extractErrorMessage(error));
    } finally {
      setBatchBusy(false);
    }
  };

  const submitConsensusExit = async (event: FormEvent) => {
    event.preventDefault();
    const parsedIndex = Number.parseInt(exitValidatorIndexInput.trim(), 10);
    if (!Number.isFinite(parsedIndex) || parsedIndex < 0) {
      setExitError('Validator index must be an integer >= 0.');
      return;
    }

    let parsedEpoch: number | null = null;
    if (exitEpochInput.trim()) {
      const value = Number.parseInt(exitEpochInput.trim(), 10);
      if (!Number.isFinite(value) || value < 0) {
        setExitError('Epoch must be an integer >= 0 or left empty.');
        return;
      }
      parsedEpoch = value;
    }

    const pubkeyError = validateHexField(exitPubkeyInput, 48, 'Validator pubkey');
    if (pubkeyError) {
      setExitError(pubkeyError);
      return;
    }

    const privateKeyError = validateHexField(exitPrivateKeyInput, 32, 'Validator private key');
    if (privateKeyError) {
      setExitError(privateKeyError);
      return;
    }

    setExitBusy(true);
    setExitError(null);
    setExitResult(null);

    try {
      const result = await api.signAndSubmitConsensusExit({
        validator_index: parsedIndex,
        validator_pubkey: exitPubkeyInput.trim(),
        validator_private_key: exitPrivateKeyInput.trim(),
        epoch: parsedEpoch,
        dry_run: exitDryRun,
      });
      setExitResult(result);
      setExitPrivateKeyInput('');
    } catch (error) {
      setExitError(extractErrorMessage(error));
    } finally {
      setExitBusy(false);
    }
  };

  const submitExecutionAction = async (event: FormEvent) => {
    event.preventDefault();

    const parsedIndex = Number.parseInt(executionValidatorIndexInput.trim(), 10);
    if (!Number.isFinite(parsedIndex) || parsedIndex < 0) {
      setExecutionError('Source validator index must be an integer >= 0.');
      return;
    }

    let parsedTarget: number | null = null;
    if (executionTargetIndexInput.trim()) {
      const value = Number.parseInt(executionTargetIndexInput.trim(), 10);
      if (!Number.isFinite(value) || value < 0) {
        setExecutionError('Target validator index must be an integer >= 0.');
        return;
      }
      parsedTarget = value;
    }

    if (executionAction === 'consolidate' && parsedTarget === null) {
      setExecutionError('Target validator index is required for consolidate.');
      return;
    }

    if (executionAction === 'consolidate' && parsedTarget === parsedIndex) {
      setExecutionError('Target validator index must differ from source validator index.');
      return;
    }

    let parsedAmount: number | null = null;
    if (executionAmountInput.trim()) {
      const value = Number.parseFloat(executionAmountInput.trim());
      if (!Number.isFinite(value) || value <= 0) {
        setExecutionError('Amount ETH must be a number > 0.');
        return;
      }
      parsedAmount = value;
    }

    if (executionAction === 'partial_withdraw' && parsedAmount === null) {
      setExecutionError('Amount ETH is required for partial withdraw.');
      return;
    }

    if (!executionDryRun) {
      const rawTx = executionRawTxInput.trim();
      if (!rawTx) {
        setExecutionError('Signed raw transaction is required when dry run is off.');
        return;
      }
      if (!/^0x[0-9a-fA-F]+$/.test(rawTx) || rawTx.length < 4) {
        setExecutionError('Signed raw transaction must be 0x-prefixed hex.');
        return;
      }
    }

    if (executionLocalPreflight && !executionLocalPreflight.eligible) {
      setExecutionError(executionLocalPreflight.reason);
      return;
    }

    setExecutionBusy(true);
    setExecutionError(null);
    setExecutionResult(null);

    try {
      const result = await api.submitExecutionAction({
        action: executionAction,
        validator_index: parsedIndex,
        target_validator_index: parsedTarget,
        amount_eth: parsedAmount,
        raw_transaction: executionRawTxInput.trim() || null,
        dry_run: executionDryRun,
      });
      setExecutionResult(result);
      if (!executionDryRun) {
        setExecutionRawTxInput('');
      }
    } catch (error) {
      setExecutionError(extractErrorMessage(error));
    } finally {
      setExecutionBusy(false);
    }
  };

  const generateKeys = async (event: FormEvent) => {
    event.preventDefault();
    const parsedCount = Number.parseInt(keyCountInput.trim(), 10);
    const count = Number.isFinite(parsedCount) ? parsedCount : 1;

    setKeygenBusy(true);
    setKeygenError(null);

    try {
      const result = await api.generateValidatorKeys(count);
      setKeygenResult(result);
    } catch (error) {
      setKeygenError(extractErrorMessage(error));
    } finally {
      setKeygenBusy(false);
    }
  };

  return (
    <section className="page operations-page">
      <div className="ops-grid">
        <section className="settings-card ops-card">
          <header>
            <h3>
              <Send size={16} />
              0x00 → 0x01 BLS change
            </h3>
            <p>{activeHint}</p>
          </header>

          <form className="ops-form" onSubmit={(event) => void submitBlsChange(event)}>
            <label>
              Validator index
              <input
                type="number"
                min={0}
                value={validatorIndexInput}
                onChange={(event) => setValidatorIndexInput(event.target.value)}
              />
            </label>

            <label>
              From BLS pubkey (0x…)
              <input
                value={fromPubkeyInput}
                onChange={(event) => setFromPubkeyInput(event.target.value)}
                placeholder="0x..."
              />
            </label>

            <label>
              To execution address (0x…)
              <input
                value={toExecutionAddressInput}
                onChange={(event) => setToExecutionAddressInput(event.target.value)}
                placeholder="0x..."
              />
            </label>

            <label>
              BLS private key (0x…)
              <input
                type="password"
                value={privateKeyInput}
                onChange={(event) => setPrivateKeyInput(event.target.value)}
                placeholder="0x..."
                autoComplete="off"
              />
            </label>

            <label className="ops-checkbox">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(event) => setDryRun(event.target.checked)}
              />
              Dry run only (sign without sending to Beacon API)
            </label>

            <button type="submit" disabled={signBusy}>
              {signBusy ? 'Processing...' : dryRun ? 'Sign dry run' : 'Sign and submit'}
            </button>
          </form>

          {signError ? <p className="gate-inline-error">{signError}</p> : null}

          {signResult ? (
            <div className="ops-result">
              <div>
                <small>Result</small>
                <strong>{signResult.submitted ? 'Submitted to Beacon API' : 'Dry run signature built'}</strong>
              </div>
              <div>
                <small>Validator</small>
                <strong>#{signResult.validator_index}</strong>
              </div>
              <div>
                <small>From pubkey</small>
                <strong className="ops-mono" title={signResult.from_bls_pubkey}>
                  {shortHex(signResult.from_bls_pubkey)}
                </strong>
              </div>
              <div>
                <small>To address</small>
                <strong className="ops-mono" title={signResult.to_execution_address}>
                  {shortHex(signResult.to_execution_address, 10)}
                </strong>
              </div>
              <div>
                <small>Domain</small>
                <strong className="ops-mono" title={signResult.domain}>
                  {shortHex(signResult.domain)}
                </strong>
              </div>
              <div>
                <small>Signing root</small>
                <strong className="ops-mono" title={signResult.signing_root}>
                  {shortHex(signResult.signing_root)}
                </strong>
              </div>
              <div>
                <small>Signature</small>
                <strong className="ops-mono" title={signResult.signature}>
                  {shortHex(signResult.signature)}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(signResult.signature);
                }}
              >
                Copy signature
              </button>
            </div>
          ) : null}
        </section>

        <section className="settings-card ops-card">
          <header>
            <h3>
              <Send size={16} />
              Batch 0x00 → 0x01
            </h3>
            <p>Multi-operations for validator batches. Row format: index,pubkey,private_key.</p>
          </header>

          <form className="ops-form" onSubmit={(event) => void submitBlsBatch(event)}>
            <label>
              To execution address (0x…)
              <input
                value={batchToExecutionAddressInput}
                onChange={(event) => setBatchToExecutionAddressInput(event.target.value)}
                placeholder="0x..."
              />
            </label>

            <label>
              Batch items
              <textarea
                value={batchItemsInput}
                onChange={(event) => setBatchItemsInput(event.target.value)}
                rows={5}
                placeholder="62936,0x...,0x...\n62937,0x...,0x..."
              />
            </label>

            <label className="ops-checkbox">
              <input
                type="checkbox"
                checked={batchDryRun}
                onChange={(event) => setBatchDryRun(event.target.checked)}
              />
              Dry run only (sign batch without sending)
            </label>

            <button type="submit" disabled={batchBusy}>
              {batchBusy ? 'Processing...' : batchDryRun ? 'Sign batch dry run' : 'Sign and submit batch'}
            </button>
          </form>

          {batchError ? <p className="gate-inline-error">{batchError}</p> : null}

          {batchResult ? (
            <div className="ops-result">
              <div>
                <small>Result</small>
                <strong>{batchResult.submitted ? 'Batch submitted to Beacon API' : 'Batch signatures built'}</strong>
              </div>
              <div>
                <small>To address</small>
                <strong className="ops-mono" title={batchResult.to_execution_address}>
                  {shortHex(batchResult.to_execution_address, 10)}
                </strong>
              </div>
              <div>
                <small>Domain</small>
                <strong className="ops-mono" title={batchResult.domain}>
                  {shortHex(batchResult.domain)}
                </strong>
              </div>
              <div>
                <small>Operations</small>
                <strong>{batchResult.items.length}</strong>
              </div>
            </div>
          ) : null}
        </section>

        <section className="settings-card ops-card">
          <header>
            <h3>
              <LogOut size={16} />
              Consensus voluntary exit
            </h3>
            <p>
              Legacy/fallback path via BLS validator signing key. Use as a safe fallback
              when EL-trigger flows are unavailable.
            </p>
          </header>

          <form className="ops-form" onSubmit={(event) => void submitConsensusExit(event)}>
            <label>
              Validator index
              <input
                type="number"
                min={0}
                value={exitValidatorIndexInput}
                onChange={(event) => setExitValidatorIndexInput(event.target.value)}
              />
            </label>

            <label>
              Validator pubkey (0x…)
              <input
                value={exitPubkeyInput}
                onChange={(event) => setExitPubkeyInput(event.target.value)}
                placeholder="0x..."
              />
            </label>

            <label>
              Epoch (optional)
              <input
                type="number"
                min={0}
                value={exitEpochInput}
                onChange={(event) => setExitEpochInput(event.target.value)}
                placeholder="empty = current epoch"
              />
            </label>

            <label>
              Validator private key (0x…)
              <input
                type="password"
                value={exitPrivateKeyInput}
                onChange={(event) => setExitPrivateKeyInput(event.target.value)}
                placeholder="0x..."
                autoComplete="off"
              />
            </label>

            <label className="ops-checkbox">
              <input
                type="checkbox"
                checked={exitDryRun}
                onChange={(event) => setExitDryRun(event.target.checked)}
              />
              Dry run only (sign voluntary exit without sending)
            </label>

            <button type="submit" disabled={exitBusy}>
              {exitBusy ? 'Processing...' : exitDryRun ? 'Sign exit dry run' : 'Sign and submit exit'}
            </button>
          </form>

          {exitError ? <p className="gate-inline-error">{exitError}</p> : null}

          {exitResult ? (
            <div className="ops-result">
              <div>
                <small>Result</small>
                <strong>{exitResult.submitted ? 'Exit submitted to Beacon API' : 'Dry run signature built'}</strong>
              </div>
              <div>
                <small>Validator</small>
                <strong>#{exitResult.validator_index}</strong>
              </div>
              <div>
                <small>Epoch</small>
                <strong>{exitResult.epoch}</strong>
              </div>
              <div>
                <small>Domain</small>
                <strong className="ops-mono" title={exitResult.domain}>
                  {shortHex(exitResult.domain)}
                </strong>
              </div>
              <div>
                <small>Signing root</small>
                <strong className="ops-mono" title={exitResult.signing_root}>
                  {shortHex(exitResult.signing_root)}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(exitResult.signature);
                }}
              >
                Copy signature
              </button>
            </div>
          ) : null}
        </section>

        <section className="settings-card ops-card">
          <header>
            <h3>
              <Wrench size={16} />
              Execution-layer actions
            </h3>
            <p>
              Submit signed raw transaction from wallet/SAFE/external signer with strict
              eligibility preflight (no withdrawal key storage inside app).
            </p>
          </header>

          <form className="ops-form" onSubmit={(event) => void submitExecutionAction(event)}>
            <label>
              Action
              <select
                value={executionAction}
                onChange={(event) => setExecutionAction(event.target.value as ExecutionActionType)}
              >
                {EXECUTION_ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Source validator index
              <input
                type="number"
                min={0}
                value={executionValidatorIndexInput}
                onChange={(event) => setExecutionValidatorIndexInput(event.target.value)}
              />
            </label>

            <label>
              Target validator index (for consolidate)
              <input
                type="number"
                min={0}
                value={executionTargetIndexInput}
                onChange={(event) => setExecutionTargetIndexInput(event.target.value)}
                placeholder="optional"
              />
            </label>

            <label>
              Amount ETH (for partial withdraw)
              <input
                value={executionAmountInput}
                onChange={(event) => setExecutionAmountInput(event.target.value)}
                placeholder="optional"
              />
            </label>

            <label>
              Signed raw transaction (0x…)
              <textarea
                rows={3}
                value={executionRawTxInput}
                onChange={(event) => setExecutionRawTxInput(event.target.value)}
                placeholder="required only when dry_run is off"
              />
            </label>

            <label className="ops-checkbox">
              <input
                type="checkbox"
                checked={executionDryRun}
                onChange={(event) => setExecutionDryRun(event.target.checked)}
              />
              Dry run only (eligibility check without on-chain submit)
            </label>

            <button type="submit" disabled={executionBusy}>
              {executionBusy ? 'Processing...' : executionDryRun ? 'Run preflight' : 'Submit execution action'}
            </button>
          </form>

          {executionLocalPreflight ? (
            <div className="ops-result">
              <div>
                <small>Signer</small>
                <strong>{executionLocalPreflight.signer}</strong>
              </div>
              <div>
                <small>Local preflight</small>
                <strong>{executionLocalPreflight.eligible ? 'Eligible' : 'Blocked'}</strong>
              </div>
              <div>
                <small>Reason</small>
                <strong>{executionLocalPreflight.reason}</strong>
              </div>
            </div>
          ) : null}

          {executionError ? <p className="gate-inline-error">{executionError}</p> : null}

          {executionResult ? (
            <div className="ops-result">
              <div>
                <small>Action</small>
                <strong>{executionResult.action}</strong>
              </div>
              <div>
                <small>Eligibility</small>
                <strong>{executionResult.eligible ? 'Eligible' : 'Blocked'}</strong>
              </div>
              <div>
                <small>Signer</small>
                <strong>{executionResult.signer}</strong>
              </div>
              <div>
                <small>Preflight reason</small>
                <strong>{executionResult.preflight_reason}</strong>
              </div>
              <div>
                <small>Submit state</small>
                <strong>{executionResult.submitted ? 'Submitted' : 'Dry run only'}</strong>
              </div>
              <div>
                <small>Tx hash</small>
                <strong className="ops-mono" title={executionResult.tx_hash ?? undefined}>
                  {executionResult.tx_hash ? shortHex(executionResult.tx_hash, 12) : '—'}
                </strong>
              </div>
            </div>
          ) : null}
        </section>

        <section className="settings-card ops-card">
          <header>
            <h3>
              <Wrench size={16} />
              Preflight diagnostics
            </h3>
            <p>Before any operation, the app shows signer model, eligibility, and block reason.</p>
          </header>

          <div className="ops-result">
            <div>
              <small>Who signs this?</small>
              <strong>0x00 → 0x01: BLS withdrawal key / mnemonic</strong>
            </div>
            <div>
              <small>Who signs this?</small>
              <strong>0x01 → 0x02, consolidate, EL exit, partial: withdrawal address wallet</strong>
            </div>
            <div>
              <small>Who signs this?</small>
              <strong>Consensus voluntary exit: validator signing key / VC API</strong>
            </div>
          </div>

          {preflight ? (
            <div className="ops-key-list">
              <div className="ops-key-list__meta">
                <small>Validator preflight</small>
                <strong>
                  #{snapshot?.record.validator_index} · {preflight.withdrawalType} · {preflight.lifecycle}
                </strong>
                <small>
                  Queue: {preflight.queue.state} · ETA {formatEta(preflight.queue.etaSeconds)} ·{' '}
                  {preflight.queue.details}
                </small>
              </div>
              {preflight.actions.map((action) => (
                <article key={action.id} className="ops-key-item">
                  <header>
                    <small>{action.label}</small>
                  </header>
                  <div>
                    <small>Eligibility</small>
                    <strong>{action.eligible ? 'Eligible' : 'Blocked'}</strong>
                  </div>
                  <div>
                    <small>Signer</small>
                    <strong>{action.signer}</strong>
                  </div>
                  <div>
                    <small>Reason</small>
                    <code>{action.reason}</code>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state ops-empty">
              <p>Select a validator to view the preflight matrix.</p>
            </div>
          )}
        </section>

        <section className="settings-card ops-card">
          <header>
            <h3>
              <KeyRound size={16} />
              Validator keypair generator
            </h3>
            <p>
              Generate BLS keys for operational workflows. Keys are returned once and are not
              stored in daemon DB.
            </p>
          </header>

          <form className="ops-form ops-form--inline" onSubmit={(event) => void generateKeys(event)}>
            <label>
              Count (1-16)
              <input
                type="number"
                min={1}
                max={16}
                value={keyCountInput}
                onChange={(event) => setKeyCountInput(event.target.value)}
              />
            </label>
            <button type="submit" disabled={keygenBusy}>
              {keygenBusy ? 'Generating...' : 'Generate'}
            </button>
          </form>

          {keygenError ? <p className="gate-inline-error">{keygenError}</p> : null}

          {keygenResult ? (
            <div className="ops-key-list">
              <div className="ops-key-list__meta">
                <small>Generated</small>
                <strong>
                  {keygenResult.count} keys · {new Date(keygenResult.generated_at).toLocaleString()}
                </strong>
              </div>

              {keygenResult.keypairs.map((entry) => (
                <article key={`${entry.index}-${entry.pubkey}`} className="ops-key-item">
                  <header>
                    <small>Key #{entry.index}</small>
                  </header>
                  <div>
                    <small>Pubkey</small>
                    <code title={entry.pubkey}>{entry.pubkey}</code>
                  </div>
                  <div>
                    <small>Private key</small>
                    <code title={entry.private_key}>{entry.private_key}</code>
                  </div>
                  <div className="ops-key-item__actions">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(entry.pubkey);
                      }}
                    >
                      Copy pubkey
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(entry.private_key);
                      }}
                    >
                      Copy private
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state ops-empty">
              <Wrench size={16} />
              <p>Generate keys to display them in this section.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
