import type { RewardsPayload } from '../types';
import { SkeletonTable } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';

type Props = {
  rewards?: RewardsPayload;
  isLoading: boolean;
  windowHours: number;
  onWindowHoursChange: (hours: number) => void;
};

const REWARD_INTERVALS = [
  { label: '1H', hours: 1 },
  { label: '6H', hours: 6 },
  { label: '24H', hours: 24 },
  { label: '7D', hours: 24 * 7 },
] as const;

const GWEI_IN_ETH = 1_000_000_000;
const EPOCH_SECONDS = 384;
const EXPECTED_ATTESTATIONS_24H = Math.round((24 * 60 * 60) / EPOCH_SECONDS);
const EXPECTED_ATTESTATIONS_7D = EXPECTED_ATTESTATIONS_24H * 7;

function toEthNumber(gwei: number): number {
  return gwei / GWEI_IN_ETH;
}

function toEth(gwei: number, precision = 5): string {
  return toEthNumber(gwei).toFixed(precision);
}

function formatDelta(gwei: number): string {
  const eth = toEthNumber(gwei);
  const sign = eth > 0 ? '+' : '';
  return `${sign}${eth.toFixed(5)} ETH`;
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  return parsed.toLocaleString();
}

function formatAgeSeconds(seconds: number): string {
  if (seconds <= 0) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m ago`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildChart(values: number[], width: number, height: number, padding: number) {
  const safeValues = values.length ? values : [0];
  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const spread = Math.max(1, max - min);
  const floorY = height - padding;
  const topY = padding;
  const stepX = safeValues.length > 1 ? width / (safeValues.length - 1) : 0;

  const points = safeValues.map((value, index) => {
    const x = safeValues.length > 1 ? index * stepX : width / 2;
    const ratio = clamp((value - min) / spread, 0, 1);
    const y = floorY - ratio * (floorY - topY);
    return { x, y, value };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const areaPath = `${linePath} L ${width.toFixed(2)} ${floorY.toFixed(2)} L 0 ${floorY.toFixed(2)} Z`;

  return {
    points,
    linePath,
    areaPath,
    min,
    max,
    floorY,
    topY,
  };
}

function statusTone(status: string): 'healthy' | 'degraded' | 'critical' | 'neutral' {
  const normalized = status.toLowerCase();
  if (normalized.includes('slashed')) {
    return 'critical';
  }
  if (normalized.includes('active')) {
    return 'healthy';
  }
  if (normalized.includes('pending') || normalized.includes('exiting')) {
    return 'degraded';
  }
  if (normalized.includes('exited') || normalized.includes('withdrawal_done')) {
    return 'neutral';
  }
  return 'degraded';
}

function reliabilityTone(score: number): 'healthy' | 'degraded' | 'critical' {
  if (score >= 95) {
    return 'healthy';
  }
  if (score >= 90) {
    return 'degraded';
  }
  return 'critical';
}

type ProjectionState = {
  dailyEth: number | null;
  weeklyEth: number | null;
  monthlyEth: number | null;
  annualEth: number | null;
  annualizedYieldPct: number | null;
  basisText: string;
  reason: 'stable' | 'preliminary' | 'warming_up' | 'unavailable';
};

export function RewardsPage({ rewards, isLoading, windowHours, onWindowHoursChange }: Props) {
  if (isLoading || !rewards) {
    return (
      <section className="page">
        <SkeletonTable rows={7} />
      </section>
    );
  }

  const historyValues = rewards.history.map((point) => point.balance_gwei);
  const chartWidth = 560;
  const chartHeight = 118;
  const chartPadding = 12;
  const chart = buildChart(historyValues, chartWidth, chartHeight, chartPadding);

  const currentBalanceEth = toEthNumber(rewards.current_balance_gwei);
  const effectiveBalanceEth = toEthNumber(rewards.effective_balance_gwei);
  const balanceHeadroomEth = Math.max(0, currentBalanceEth - effectiveBalanceEth);

  const activeLike = rewards.status.toLowerCase().includes('active');
  const expected24h = activeLike ? EXPECTED_ATTESTATIONS_24H : 0;
  const expected7d = activeLike ? EXPECTED_ATTESTATIONS_7D : 0;
  const reliability24hPct =
    expected24h > 0
      ? clamp(((expected24h - rewards.missed_attestations_24h) / expected24h) * 100, 0, 100)
      : 0;
  const reliability7dPct =
    expected7d > 0
      ? clamp(((expected7d - rewards.missed_attestations_7d) / expected7d) * 100, 0, 100)
      : 0;
  const scoreFromMissed24h = (100 - reliability24hPct) * 0.55;
  const scoreFromMissed7d = (100 - reliability7dPct) * 0.30;
  const scoreFromStreak = Math.min(20, rewards.missed_attestation_streak * 2);
  const reliabilityScore = clamp(
    100 - scoreFromMissed24h - scoreFromMissed7d - scoreFromStreak,
    0,
    100
  );

  const generatedAtDate = new Date(rewards.generated_at);
  const dataAgeSeconds = Number.isNaN(generatedAtDate.getTime())
    ? 0
    : Math.max(0, Math.floor((Date.now() - generatedAtDate.getTime()) / 1000));

  const firstPoint = rewards.history[0];
  const lastPoint = rewards.history[rewards.history.length - 1];
  const firstPointDate = firstPoint ? new Date(firstPoint.observed_at) : null;
  const lastPointDate = lastPoint ? new Date(lastPoint.observed_at) : null;
  const historySpanHours =
    firstPointDate && lastPointDate && !Number.isNaN(firstPointDate.getTime()) && !Number.isNaN(lastPointDate.getTime())
      ? (lastPointDate.getTime() - firstPointDate.getTime()) / (1000 * 60 * 60)
      : 0;

  let projection: ProjectionState;
  const projectionBasisHours = rewards.projection_basis_hours ?? null;
  const projectionDailyEth =
    rewards.projection_daily_gwei === null || rewards.projection_daily_gwei === undefined
      ? null
      : toEthNumber(rewards.projection_daily_gwei);

  if (rewards.projection_state === 'unavailable') {
    projection = {
      dailyEth: null,
      weeklyEth: null,
      monthlyEth: null,
      annualEth: null,
      annualizedYieldPct: null,
      basisText: `Unavailable for validator status ${rewards.status}.`,
      reason: 'unavailable',
    };
  } else if (rewards.projection_state === 'warming_up') {
    projection = {
      dailyEth: null,
      weeklyEth: null,
      monthlyEth: null,
      annualEth: null,
      annualizedYieldPct: null,
      basisText:
        projectionBasisHours !== null
          ? `Projection warming up. ${projectionBasisHours.toFixed(1)}h collected locally. Preliminary forecast starts after 6h; stable forecast after 24h.`
          : 'Projection warming up. Preliminary forecast starts after 6h of local history; stable forecast after 24h.',
      reason: 'warming_up',
    };
  } else if (projectionDailyEth !== null) {
    const dailyEth = projectionDailyEth;
    const annualEth = dailyEth * 365;
    projection = {
      dailyEth,
      weeklyEth: dailyEth * 7,
      monthlyEth: dailyEth * 30,
      annualEth,
      annualizedYieldPct: effectiveBalanceEth > 0 ? (annualEth / effectiveBalanceEth) * 100 : null,
      basisText:
        rewards.projection_state === 'preliminary'
          ? `Preliminary forecast scaled from ${projectionBasisHours?.toFixed(1) ?? '—'}h of local history.`
          : `Based on ${projectionBasisHours?.toFixed(1) ?? '24.0'}h local baseline.`,
      reason: rewards.projection_state === 'preliminary' ? 'preliminary' : 'stable',
    };
  } else {
    projection = {
      dailyEth: null,
      weeklyEth: null,
      monthlyEth: null,
      annualEth: null,
      annualizedYieldPct: null,
      basisText: 'Projection warming up. Preliminary forecast starts after 6h; stable forecast after 24h.',
      reason: 'warming_up',
    };
  }

  const insights: string[] = [];
  if (!activeLike) {
    insights.push(
      `Validator status ${rewards.status} is not active_ongoing: reward dynamics may be unrepresentative.`
    );
  }
  if (rewards.missed_attestation_streak >= 2) {
    insights.push(
      `Missed streak = ${rewards.missed_attestation_streak}. Check CL endpoint latency and network stability.`
    );
  }
  if (rewards.missed_attestations_24h > 0) {
    insights.push(
      `${rewards.missed_attestations_24h} attestations were missed in 24h. Verify validator client uptime and peer quality.`
    );
  }
  if (projection.reason === 'unavailable') {
    insights.push('PnL projections are disabled for exited, withdrawn, or non-active validators.');
  }
  if (projection.reason === 'warming_up') {
    insights.push('Projection baseline is still warming up. Keep the daemon running until at least 6h of local history is collected.');
  }
  if (projection.reason === 'preliminary') {
    insights.push('PnL forecast is still preliminary because the local baseline is below 24h.');
  }
  if (projection.dailyEth !== null && projection.dailyEth < 0) {
    insights.push(
      'Daily run-rate is negative. Check incidents, missed attestations, and failover behavior.'
    );
  }
  if (balanceHeadroomEth > 0.05) {
    insights.push(
      `Balance headroom is ${balanceHeadroomEth.toFixed(4)} ETH above effective balance. Review withdrawal policy.`
    );
  }
  if (dataAgeSeconds > 900) {
    insights.push(
      `Data was last updated ${formatAgeSeconds(dataAgeSeconds)}. Manual retry and daemon health check are recommended.`
    );
  }
  if (!insights.length) {
    insights.push('No critical deviations detected. Continue standard duties/rewards monitoring.');
  }

  const latestChartPoint = chart.points[chart.points.length - 1];
  const earliestChartPoint = chart.points[0];

  const positive1h = rewards.delta_1h_gwei >= 0;
  const positive24h = rewards.delta_24h_gwei >= 0;
  const positive7d = rewards.delta_7d_gwei >= 0;
  const positiveRunRate = projection.dailyEth !== null && projection.dailyEth >= 0;

  return (
    <section className="page page-rewards">
      <section className="table-shell">
        <header>
          <h2>
            Balance curve ({REWARD_INTERVALS.find((option) => option.hours === windowHours)?.label ?? '24H'})
          </h2>
          <p>
            Min: {toEth(chart.min, 5)} ETH · Max: {toEth(chart.max, 5)} ETH · Latest: {toEth(rewards.current_balance_gwei, 5)} ETH
          </p>
          <div className="rewards-intervals" role="group" aria-label="Balance history interval">
            {REWARD_INTERVALS.map((option) => (
              <button
                key={option.hours}
                type="button"
                className={windowHours === option.hours ? 'is-active' : ''}
                onClick={() => onWindowHoursChange(option.hours)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </header>
        <div className="rewards-chart">
          <svg
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Balance history"
          >
            <defs>
              <linearGradient id="rewardsStroke" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#8f9bcb" />
                <stop offset="100%" stopColor="var(--accent)" />
              </linearGradient>
              <linearGradient id="rewardsArea" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.04" />
              </linearGradient>
            </defs>

            {[0, 0.25, 0.5, 0.75, 1].map((ratio, index) => {
              const y = chart.floorY - ratio * (chart.floorY - chart.topY);
              return <line key={index} className="rewards-chart__grid" x1={0} y1={y} x2={chartWidth} y2={y} />;
            })}

            <path d={chart.areaPath} className="rewards-chart__area" />
            <path d={chart.linePath} className="rewards-chart__line" />
            <circle className="rewards-chart__point-start" cx={earliestChartPoint.x} cy={earliestChartPoint.y} r={3.6} />
            <circle className="rewards-chart__point-end" cx={latestChartPoint.x} cy={latestChartPoint.y} r={4.4} />
          </svg>
          <div className="rewards-chart__axis">
            <span>{firstPoint ? formatDateTime(firstPoint.observed_at) : '—'}</span>
            <span>{lastPoint ? formatDateTime(lastPoint.observed_at) : '—'}</span>
          </div>
        </div>
      </section>

      <section className="rewards-reliability">
        <article>
          <small>Attestation reliability 24h</small>
          <strong>{activeLike ? formatPct(reliability24hPct) : 'n/a'}</strong>
          <div className="reliability-bar">
            <div style={{ width: `${activeLike ? clamp(reliability24hPct, 0, 100) : 0}%` }} />
          </div>
          <p>
            Missed: {rewards.missed_attestations_24h} / expected {activeLike ? expected24h : 'n/a'}
          </p>
        </article>
        <article>
          <small>Attestation reliability 7d</small>
          <strong>{activeLike ? formatPct(reliability7dPct) : 'n/a'}</strong>
          <div className="reliability-bar">
            <div style={{ width: `${activeLike ? clamp(reliability7dPct, 0, 100) : 0}%` }} />
          </div>
          <p>
            Missed: {rewards.missed_attestations_7d} / expected {activeLike ? expected7d : 'n/a'}
          </p>
        </article>
        <article>
          <small>PnL projections</small>
          <strong>
            {projection.monthlyEth === null
              ? projection.reason === 'unavailable'
                ? 'n/a'
                : 'Projection warming up'
              : `${projection.monthlyEth >= 0 ? '+' : ''}${projection.monthlyEth.toFixed(5)} ETH / 30d`}
          </strong>
          <p>
            {projection.annualEth === null
              ? projection.reason === 'unavailable'
                ? 'n/a'
                : projection.reason === 'warming_up'
                  ? 'Waiting for minimum local baseline'
                  : 'Preliminary'
              : `${projection.annualEth >= 0 ? '+' : ''}${projection.annualEth.toFixed(5)} ETH / year`}
          </p>
          <p>{projection.basisText}</p>
        </article>
      </section>

      <section className="rewards-kpis">
        <article className="rewards-kpi">
          <small>Current balance</small>
          <strong>{toEth(rewards.current_balance_gwei)} ETH</strong>
          <p>Effective: {toEth(rewards.effective_balance_gwei)} ETH</p>
          <p>Headroom: {balanceHeadroomEth.toFixed(4)} ETH</p>
        </article>
        <article className="rewards-kpi">
          <small>Validator status</small>
          <strong>
            <StatusPill tone={statusTone(rewards.status)} label={rewards.status} />
          </strong>
          <p
            className="rewards-kpi__address"
            title={rewards.withdrawal_address ?? undefined}
          >
            {rewards.withdrawal_address ?? 'Withdrawal address unavailable'}
          </p>
          <p>Validator #{rewards.validator_index}</p>
        </article>
        <article className="rewards-kpi">
          <small>Missed attestations</small>
          <strong>{rewards.missed_attestations_24h} / 24h</strong>
          <p>{rewards.missed_attestations_7d} / 7d · streak {rewards.missed_attestation_streak}</p>
        </article>
        <article className="rewards-kpi">
          <small>Reliability score</small>
          <strong>
            <StatusPill tone={reliabilityTone(reliabilityScore)} label={`${reliabilityScore.toFixed(1)} / 100`} />
          </strong>
          <p>24h attestation success: {activeLike ? formatPct(reliability24hPct) : 'n/a'}</p>
          <p>7d attestation success: {activeLike ? formatPct(reliability7dPct) : 'n/a'}</p>
        </article>
        <article className="rewards-kpi">
          <small>Data freshness</small>
          <strong>{formatAgeSeconds(dataAgeSeconds)}</strong>
          <p>Updated: {formatDateTime(rewards.generated_at)}</p>
          <p>Samples: {rewards.history.length} · Span: {historySpanHours.toFixed(1)}h</p>
        </article>
      </section>

      <section className="rewards-deltas">
        <article className={positive1h ? 'is-positive' : 'is-negative'}>
          <small>PnL 1h</small>
          <strong>{formatDelta(rewards.delta_1h_gwei)}</strong>
        </article>
        <article className={positive24h ? 'is-positive' : 'is-negative'}>
          <small>PnL 24h</small>
          <strong>{formatDelta(rewards.delta_24h_gwei)}</strong>
        </article>
        <article className={positive7d ? 'is-positive' : 'is-negative'}>
          <small>PnL 7d</small>
          <strong>{formatDelta(rewards.delta_7d_gwei)}</strong>
        </article>
        <article
          className={
            projection.dailyEth === null ? undefined : positiveRunRate ? 'is-positive' : 'is-negative'
          }
        >
          <small>Run-rate / day</small>
          <strong>
            {projection.dailyEth === null
              ? projection.reason === 'unavailable'
                ? 'n/a'
                : 'Warming up'
              : `${positiveRunRate ? '+' : ''}${projection.dailyEth.toFixed(5)} ETH`}
          </strong>
        </article>
        <article
          className={
            projection.annualizedYieldPct === null
              ? undefined
              : projection.annualizedYieldPct >= 0
                ? 'is-positive'
                : 'is-negative'
          }
        >
          <small>Annualized yield (est.)</small>
          <strong>
            {projection.annualizedYieldPct === null
              ? 'n/a'
              : `${projection.annualizedYieldPct >= 0 ? '+' : ''}${projection.annualizedYieldPct.toFixed(2)}%`}
          </strong>
        </article>
        <article
          className={
            projection.weeklyEth === null
              ? undefined
              : projection.weeklyEth >= 0
                ? 'is-positive'
                : 'is-negative'
          }
        >
          <small>Projected 7d</small>
          <strong>
            {projection.weeklyEth === null
              ? projection.reason === 'unavailable'
                ? 'n/a'
                : 'Warming up'
              : `${projection.weeklyEth >= 0 ? '+' : ''}${projection.weeklyEth.toFixed(5)} ETH`}
          </strong>
        </article>
      </section>

      <section className="rewards-insights">
        <header>
          <h2>Operational insights</h2>
          <p>Automatic hints for reliability, profitability, and data freshness.</p>
        </header>
        <ul>
          {insights.map((item, index) => (
            <li key={`insight-${index}`}>{item}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}
