import type { DutiesPayload } from '../types';
import { SkeletonTable } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';

type Props = {
  duties?: DutiesPayload;
  isLoading: boolean;
  validatorIndex?: number | null;
};

function toEta(seconds?: number | null): string {
  if (!seconds || seconds <= 0) {
    return '—';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${remaining}s`;
  }
  return `${remaining}s`;
}

function toEth(gwei: number): string {
  return (gwei / 1_000_000_000).toFixed(4);
}

export function DutiesPage({ duties, isLoading, validatorIndex }: Props) {
  if (isLoading || !duties) {
    return (
      <section className="page">
        <SkeletonTable rows={7} />
      </section>
    );
  }

  const scoped = validatorIndex
    ? duties.validators.filter((entry) => entry.validator_index === validatorIndex)
    : duties.validators;

  const nextDuty = scoped
    .filter((entry) => entry.slots_until_proposal !== null && entry.slots_until_proposal !== undefined)
    .sort((a, b) => (a.slots_until_proposal ?? Number.MAX_SAFE_INTEGER) - (b.slots_until_proposal ?? Number.MAX_SAFE_INTEGER))[0];

  return (
    <section className="page page-duties">
      <section className="duties-kpis">
        <article className="duties-kpi">
          <small>Current slot</small>
          <strong>{duties.current_slot ?? '—'}</strong>
          <p>Epoch {duties.current_epoch ?? '—'}</p>
        </article>
        <article className="duties-kpi">
          <small>Next proposal</small>
          <strong>{nextDuty?.next_proposer_slot ?? '—'}</strong>
          <p>ETA {toEta(nextDuty?.eta_seconds_until_proposal)}</p>
        </article>
        <article className="duties-kpi">
          <small>Safe maintenance</small>
          <strong>
            {duties.safe_maintenance_slots ? `${duties.safe_maintenance_slots} slots` : 'Open'}
          </strong>
          <p>
            until slot {duties.safe_maintenance_until_slot ?? '—'} · {duties.slot_duration_seconds}s/slot
          </p>
        </article>
      </section>

      <section className="table-shell">
        <header>
          <h2>Validator duty status</h2>
          <p>Snapshot of proposer/sync readiness and balance state.</p>
        </header>

        {!scoped.length ? (
          <div className="empty-state">Duty data is temporarily unavailable</div>
        ) : (
          <div className="duties-table">
            <div className="duties-table__header">
              <span>Validator</span>
              <span>Status</span>
              <span>Next proposer</span>
              <span>Countdown</span>
              <span>Sync committees</span>
              <span>Balance</span>
            </div>
            {scoped.map((entry) => (
              <div key={entry.validator_index} className="duties-table__row">
                <span>#{entry.validator_index}</span>
                <span>
                  <StatusPill
                    tone={entry.status.includes('active') ? 'healthy' : 'degraded'}
                    label={entry.status}
                  />
                </span>
                <span>{entry.next_proposer_slot ?? '—'}</span>
                <span>{toEta(entry.eta_seconds_until_proposal)}</span>
                <span>
                  {entry.in_current_sync_committee
                    ? 'current'
                    : entry.in_next_sync_committee
                      ? 'next'
                      : 'none'}
                </span>
                <span>{toEth(entry.current_balance_gwei)} ETH</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
