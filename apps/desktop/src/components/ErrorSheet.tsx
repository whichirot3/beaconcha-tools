import { useState } from 'react';
import type { ErrorSheetPayload } from '../types';

type Props = {
  error: ErrorSheetPayload | null;
  onClose: () => void;
  onRetry: () => void;
  onCopyDiagnostics: () => void;
  onOpenLogs: () => void;
  onResetState: () => void;
};

export function ErrorSheet({
  error,
  onClose,
  onRetry,
  onCopyDiagnostics,
  onOpenLogs,
  onResetState,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!error) {
    return null;
  }

  return (
    <div className="error-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="error-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="error-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="error-sheet__header">
          <h2 id="error-title">{error.title}</h2>
          <span className="error-code">{error.error_code}</span>
        </div>

        <p>{error.message}</p>

        <div className="error-sheet__actions">
          <button type="button" onClick={onRetry}>
            Retry
          </button>
          <button type="button" onClick={onCopyDiagnostics}>
            Copy diagnostics
          </button>
          <button type="button" onClick={onOpenLogs}>
            Open logs
          </button>
          <button type="button" onClick={onResetState}>
            Reset state
          </button>
        </div>

        <button
          type="button"
          className="error-sheet__toggle"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Hide technical details' : 'Show technical details'}
        </button>

        {expanded ? <pre>{error.technical_details}</pre> : null}
      </div>
    </div>
  );
}
