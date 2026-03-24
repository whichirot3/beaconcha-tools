import type { EndpointHealth } from '../types';
import { SkeletonTable } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';

type Props = {
  endpoints?: EndpointHealth[];
  isLoading: boolean;
};

function tone(score: number): 'healthy' | 'degraded' | 'critical' {
  if (score >= 70) {
    return 'healthy';
  }
  if (score >= 35) {
    return 'degraded';
  }
  return 'critical';
}

export function HealthPage({ endpoints, isLoading }: Props) {
  if (isLoading || !endpoints) {
    return (
      <section className="page">
        <SkeletonTable rows={8} />
      </section>
    );
  }

  return (
    <section className="page page-health">
      <section className="endpoint-grid">
        {endpoints.map((endpoint) => {
          const healthTone = tone(endpoint.score);
          return (
            <article key={`${endpoint.kind}:${endpoint.name}`} className="endpoint-card">
              <header>
                <div>
                  <small>{endpoint.kind.toUpperCase()}</small>
                  <h3>{endpoint.name}</h3>
                </div>
                <StatusPill tone={healthTone} label={endpoint.score.toFixed(1)} />
              </header>

              <div className="endpoint-meter" role="presentation">
                <div style={{ width: `${Math.max(2, endpoint.score)}%` }} />
              </div>

              <dl>
                <div>
                  <dt>Latency</dt>
                  <dd>{endpoint.latency_ms} ms</dd>
                </div>
                <div>
                  <dt>Failures</dt>
                  <dd>{endpoint.failure_count}</dd>
                </div>
                <div>
                  <dt>Success</dt>
                  <dd>{endpoint.success_count}</dd>
                </div>
              </dl>

              <p title={endpoint.last_error ?? ''}>{endpoint.last_error ?? 'No recent errors'}</p>
            </article>
          );
        })}
      </section>
    </section>
  );
}
