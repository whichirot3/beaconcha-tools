import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ValidatorSnapshot } from '../types';
import { StatusPill } from './StatusPill';

type Props = {
  validators: ValidatorSnapshot[];
};

function gweiToEth(gwei: number) {
  return (gwei / 1_000_000_000).toFixed(5);
}

function shortHex(value: string) {
  if (!value) {
    return '—';
  }
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function ValidatorTable({ validators }: Props) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const sorted = useMemo(
    () => [...validators].sort((a, b) => a.record.validator_index - b.record.validator_index),
    [validators]
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 12,
  });

  if (!sorted.length) {
    return <div className="empty-state">Validator metrics are temporarily unavailable</div>;
  }

  return (
    <div className="validator-table">
      <div className="validator-table__scroll">
        <div className="validator-table__header">
          <span>Index</span>
          <span>Identity</span>
          <span>Status</span>
          <span>Balance</span>
          <span>Proposer</span>
          <span>Sync</span>
          <span>Tags</span>
        </div>
        <div className="validator-table__body" ref={parentRef}>
          <div
            className="validator-table__canvas"
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = sorted[virtualRow.index];
              const statusTone = row.record.status.includes('active')
                ? 'healthy'
                : row.record.status.includes('slashed')
                  ? 'critical'
                  : 'degraded';

              return (
                <div
                  key={row.record.validator_index}
                  className="validator-table__row"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: `${virtualRow.size}px`,
                  }}
                >
                  <span>#{row.record.validator_index}</span>
                  <div className="validator-table__identity">
                    <strong>{row.record.meta.label ?? 'Untitled validator'}</strong>
                    <small title={row.record.pubkey}>{shortHex(row.record.pubkey)}</small>
                  </div>
                  <span>
                    <StatusPill tone={statusTone} label={row.record.status} />
                  </span>
                  <span>{gweiToEth(row.record.current_balance_gwei)} ETH</span>
                  <span>{row.record.next_proposer_slot ?? '—'}</span>
                  <span>
                    {row.record.in_current_sync_committee
                      ? 'Current committee'
                      : row.record.in_next_sync_committee
                        ? 'Next committee'
                        : '—'}
                  </span>
                  <div className="validator-table__tags">
                    <small>{row.record.meta.node ?? 'node: —'}</small>
                    <small>{row.record.meta.cluster ?? 'cluster: —'}</small>
                    <small>{row.record.meta.operator ?? 'operator: —'}</small>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
