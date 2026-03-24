import { useMemo, useState } from 'react';
import type { DashboardPayload } from '../types';
import { SkeletonCard, SkeletonTable } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import { deriveInventory, formatEta } from '../lib/eligibility';

type Props = {
  data?: DashboardPayload;
  isLoading: boolean;
  activeValidatorIndex?: number | null;
  isActiveValidatorHydrating?: boolean;
};

function toEth(gwei: number) {
  return gwei / 1_000_000_000;
}

function shortHex(value: string, edge = 10) {
  if (!value) {
    return '—';
  }
  if (value.length <= edge * 2 + 2) {
    return value;
  }
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

type TrendInterval = {
  id: '3h' | '6h' | '12h' | '24h';
  label: string;
  windowHours: number;
  points: number;
};

const TREND_INTERVALS: TrendInterval[] = [
  { id: '3h', label: '3h', windowHours: 3, points: 12 },
  { id: '6h', label: '6h', windowHours: 6, points: 12 },
  { id: '12h', label: '12h', windowHours: 12, points: 12 },
  { id: '24h', label: '24h', windowHours: 24, points: 12 },
];

function trendSeries(
  incidents: DashboardPayload['incidents'],
  points: number,
  windowHours: number
) {
  const now = Date.now();
  const bucketMs = (windowHours * 60 * 60 * 1000) / points;
  const buckets = Array.from({ length: points }, (_, index) => {
    const start = now - (points - index) * bucketMs;
    const end = start + bucketMs;
    let score = 0;
    for (const incident of incidents) {
      const occurredAt = new Date(incident.occurred_at).getTime();
      if (occurredAt < start || occurredAt >= end) {
        continue;
      }
      if (incident.severity === 'critical') {
        score += 3;
      } else if (incident.severity === 'warning') {
        score += 1;
      } else {
        score += 0.4;
      }
    }
    return Math.round(score * 10) / 10;
  });

  return buckets;
}

function buildTrendGeometry(values: number[], width: number, height: number, padding: number) {
  const safeValues = values.length ? values : [0];
  const maxValue = Math.max(1, ...safeValues);
  const stepX = safeValues.length > 1 ? width / (safeValues.length - 1) : width;
  const floorY = height - padding;
  const topY = padding;

  const points = safeValues.map((value, index) => {
    const x = stepX * index;
    const ratio = Math.max(0, Math.min(1, value / maxValue));
    const y = floorY - ratio * (floorY - topY);
    return {
      value,
      x,
      y,
    };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const areaPath = `${linePath} L ${width.toFixed(2)} ${floorY.toFixed(2)} L 0 ${floorY.toFixed(2)} Z`;

  return {
    points,
    linePath,
    areaPath,
    maxValue,
    floorY,
    topY,
  };
}

export function DashboardPage({
  data,
  isLoading,
  activeValidatorIndex = null,
  isActiveValidatorHydrating = false,
}: Props) {
  const [intervalId, setIntervalId] = useState<TrendInterval['id']>('12h');
  const selectedInterval =
    TREND_INTERVALS.find((interval) => interval.id === intervalId) ?? TREND_INTERVALS[2];
  const selectedPubkeys = useMemo(() => {
    if (!data || activeValidatorIndex === null) {
      return [];
    }

    return data.validators
      .filter((validator) => validator.record.validator_index === activeValidatorIndex)
      .map((validator) => validator.record.pubkey.toLowerCase());
  }, [data, activeValidatorIndex]);
  const scopedIncidents = useMemo(() => {
    if (!data) {
      return [];
    }

    if (activeValidatorIndex === null) {
      return data.incidents;
    }

    const indexText = String(activeValidatorIndex);
    return data.incidents.filter((incident) => {
      const text = `${incident.message} ${incident.details}`.toLowerCase();
      if (selectedPubkeys.some((pubkey) => text.includes(pubkey))) {
        return true;
      }

      const mentionedIndices = [...text.matchAll(/validator\s+#?(\d+)/gi)].map(
        (match) => match[1]
      );
      if (mentionedIndices.length > 0) {
        return mentionedIndices.includes(indexText);
      }

      return false;
    });
  }, [data, activeValidatorIndex, selectedPubkeys]);
  const trend = useMemo(
    () =>
      data
        ? trendSeries(scopedIncidents, selectedInterval.points, selectedInterval.windowHours)
        : [],
    [data, scopedIncidents, selectedInterval.points, selectedInterval.windowHours]
  );

  if (isLoading || !data) {
    return (
      <section className="page page-dashboard">
        <div className="kpi-grid">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonTable rows={12} />
      </section>
    );
  }

  const metricValidators =
    activeValidatorIndex === null
      ? data.validators
      : data.validators.filter(
          (validator) => validator.record.validator_index === activeValidatorIndex
        );

  const trackedCount = metricValidators.length;
  const observedCount = metricValidators.length;
  const active = metricValidators.filter((validator) =>
    validator.record.status.includes('active')
  ).length;
  const inactive = observedCount - active;
  const totalBalance = metricValidators.reduce(
    (sum, validator) => sum + validator.record.current_balance_gwei,
    0
  );
  const avgBalance = observedCount ? totalBalance / observedCount : 0;
  const upcomingProposers = metricValidators.filter(
    (validator) => validator.record.next_proposer_slot !== null && validator.record.next_proposer_slot !== undefined
  ).length;
  const criticalIncidents = scopedIncidents.filter(
    (incident) => incident.severity === 'critical'
  ).length;

  const cacheTotal = data.runtime.cache_hits + data.runtime.cache_misses;
  const cacheRatio = cacheTotal > 0 ? (data.runtime.cache_hits / cacheTotal) * 100 : 0;

  const trendNow = trend[trend.length - 1] ?? 0;
  const trendPeak = Math.max(1, ...trend);
  const chartWidth = 560;
  const chartHeight = 122;
  const chartPadding = 12;
  const chart = buildTrendGeometry(trend, chartWidth, chartHeight, chartPadding);
  const gridY = [0, 0.25, 0.5, 0.75, 1].map(
    (ratio) => chart.floorY - ratio * (chart.floorY - chart.topY)
  );
  const firstPoint = chart.points[0];
  const lastPoint = chart.points[chart.points.length - 1];
  const inventoryItems = [...data.validators].sort(
    (a, b) => a.record.validator_index - b.record.validator_index
  );
  const showHydratingState =
    isActiveValidatorHydrating && activeValidatorIndex !== null && metricValidators.length === 0;

  return (
    <section className="page page-dashboard">
      <section className="dashboard-canvas">
        <section className="dashboard-strip">
          <article>
            <small>Beacon head</small>
            <strong>{data.chain_head?.slot ?? '—'}</strong>
            <span>slot</span>
          </article>
          <article>
            <small>Current epoch</small>
            <strong>{data.chain_head?.epoch ?? '—'}</strong>
            <span>epoch</span>
          </article>
          <article>
            <small>Execution head</small>
            <strong>{data.execution_head?.block_number ?? '—'}</strong>
            <span>block</span>
          </article>
          <article>
            <small>Finalized epoch</small>
            <strong>{data.chain_head?.finalized_epoch ?? '—'}</strong>
            <span>finalized</span>
          </article>
        </section>

        <section className="dashboard-main">
          <section className="dashboard-metrics">
            <article>
              <small>Tracked validators</small>
              <strong>{showHydratingState ? 'Syncing…' : trackedCount}</strong>
              <p>
                {showHydratingState
                  ? `Waiting for validator #${activeValidatorIndex} snapshot`
                  : `${observedCount} with metrics / ${active} active / ${inactive} non-active`}
              </p>
            </article>
            <article>
              <small>Average balance</small>
              <strong>{showHydratingState ? 'Syncing…' : `${toEth(avgBalance).toFixed(4)} ETH`}</strong>
              <p>
                {showHydratingState
                  ? 'Balance will appear as soon as the daemon snapshot is ready.'
                  : `Total: ${toEth(totalBalance).toFixed(2)} ETH`}
              </p>
            </article>
            <article>
              <small>Upcoming proposers</small>
              <strong>{upcomingProposers}</strong>
              <p>Current + next epoch window</p>
            </article>
            <article>
              <small>Critical incidents</small>
              <strong>{criticalIncidents}</strong>
              <p>Latest 100 incident records</p>
            </article>
          </section>

          <aside className="dashboard-runtime">
            <small>Runtime mode</small>
            <StatusPill
              tone={data.runtime.mode === 'healthy' ? 'healthy' : 'degraded'}
              label={data.runtime.mode}
            />
            <div>
              <small>Failover</small>
              <strong>{data.runtime.rpc_failover_active ? 'active' : 'standby'}</strong>
            </div>
            <div>
              <small>Cache hit ratio</small>
              <strong>{cacheRatio.toFixed(0)}%</strong>
            </div>
            <div>
              <small>Incident pulse</small>
              <strong>
                {trendNow.toFixed(1)} / {trendPeak.toFixed(1)}
              </strong>
            </div>
          </aside>
        </section>

        <section className="dashboard-chart">
          <header>
            <h2>Incident pulse</h2>
            <div className="dashboard-chart__controls" role="group" aria-label="Incident pulse interval">
              {TREND_INTERVALS.map((interval) => (
                <button
                  key={interval.id}
                  type="button"
                  className={interval.id === intervalId ? 'is-active' : ''}
                  onClick={() => setIntervalId(interval.id)}
                >
                  {interval.label}
                </button>
              ))}
            </div>
          </header>
          <div className="dashboard-chart__canvas">
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Incident pulse chart"
            >
              <defs>
                <linearGradient id="dashboardPulseStroke" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#8f9bcb" />
                  <stop offset="55%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="#d17878" />
                </linearGradient>
                <linearGradient id="dashboardPulseArea" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.24" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
                </linearGradient>
              </defs>

              {gridY.map((y, index) => (
                <line
                  key={`grid-${index}`}
                  className="dashboard-chart__grid"
                  x1={0}
                  y1={y}
                  x2={chartWidth}
                  y2={y}
                />
              ))}

              <line
                className="dashboard-chart__baseline"
                x1={0}
                y1={chart.floorY}
                x2={chartWidth}
                y2={chart.floorY}
              />
              <path className="dashboard-chart__area" d={chart.areaPath} />
              <path className="dashboard-chart__line" d={chart.linePath} />

              {chart.points.map((point, index) => (
                <circle
                  key={`point-${index}`}
                  className="dashboard-chart__point"
                  cx={point.x}
                  cy={point.y}
                  r={index === 0 || index === chart.points.length - 1 ? 3.2 : 2}
                />
              ))}

              <circle className="dashboard-chart__point-glow" cx={lastPoint.x} cy={lastPoint.y} r={6.8} />
              <circle className="dashboard-chart__point-edge" cx={firstPoint.x} cy={firstPoint.y} r={4.2} />
              <circle className="dashboard-chart__point-edge" cx={lastPoint.x} cy={lastPoint.y} r={4.2} />
            </svg>
            <div className="dashboard-chart__axis">
              <span>{selectedInterval.windowHours}h ago</span>
              <span>{Math.round(selectedInterval.windowHours / 2)}h</span>
              <span>now</span>
            </div>
          </div>
        </section>

        <section className="dashboard-inventory">
          <header>
            <h2>Validator inventory</h2>
            <p>
              Full validator list with credentials, lifecycle, balances, and action eligibility
              matrix.
            </p>
          </header>

          {!inventoryItems.length ? (
            <div className="empty-state">No validators imported</div>
          ) : (
            <div className="inventory-grid">
              {inventoryItems.map((snapshot) => {
                const derived = deriveInventory(snapshot, data.chain_head?.epoch);
                const eligibleCount = derived.actions.filter((action) => action.eligible).length;
                const blocked = derived.actions.filter((action) => !action.eligible);

                return (
                  <article
                    key={snapshot.record.validator_index}
                    className={`inventory-card${activeValidatorIndex === snapshot.record.validator_index ? ' is-active' : ''}`}
                  >
                    <header>
                      <div>
                        <small>Validator</small>
                        <h3>#{snapshot.record.validator_index}</h3>
                      </div>
                      <StatusPill
                        tone={
                          derived.lifecycle === 'slashed'
                            ? 'critical'
                            : derived.lifecycle === 'active'
                              ? 'healthy'
                              : derived.lifecycle === 'pending' || derived.lifecycle === 'exiting'
                                ? 'degraded'
                                : 'neutral'
                        }
                        label={snapshot.record.status}
                      />
                    </header>

                    <div className="inventory-card__meta">
                      <div>
                        <small>Pubkey</small>
                        <strong title={snapshot.record.pubkey}>{shortHex(snapshot.record.pubkey, 12)}</strong>
                      </div>
                      <div>
                        <small>Credentials</small>
                        <strong>{derived.withdrawalType}</strong>
                      </div>
                      <div>
                        <small>Withdrawal address</small>
                        <strong title={snapshot.record.withdrawal_address ?? undefined}>
                          {shortHex(snapshot.record.withdrawal_address ?? '', 8)}
                        </strong>
                      </div>
                      <div>
                        <small>Balance</small>
                        <strong>{toEth(snapshot.record.current_balance_gwei).toFixed(4)} ETH</strong>
                      </div>
                      <div>
                        <small>Effective</small>
                        <strong>{toEth(snapshot.record.effective_balance_gwei).toFixed(4)} ETH</strong>
                      </div>
                      <div>
                        <small>Queue</small>
                        <strong>
                          {derived.queue.state} · ETA {formatEta(derived.queue.etaSeconds)}
                        </strong>
                      </div>
                    </div>

                    <div className="inventory-card__actions">
                      <small>
                        Action eligibility: {eligibleCount}/{derived.actions.length}
                      </small>
                      <div className="inventory-card__chips">
                        {derived.actions.map((action) => (
                          <StatusPill
                            key={`${snapshot.record.validator_index}-${action.id}`}
                            tone={action.eligible ? 'healthy' : 'neutral'}
                            label={action.label}
                          />
                        ))}
                      </div>
                    </div>

                    {blocked.length ? (
                      <div className="inventory-card__diagnostics">
                        <small>Why blocked</small>
                        <ul>
                          {blocked.slice(0, 3).map((item) => (
                            <li key={`${snapshot.record.validator_index}-${item.id}`}>
                              <strong>{item.label}:</strong> {item.reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>

    </section>
  );
}
