import type { DashboardPayload } from '../types';

export function DiagnosticsPanel({ payload }: { payload: DashboardPayload }) {
  const critical = payload.incidents.filter((incident) => incident.severity === 'critical').length;
  const warnings = payload.incidents.filter((incident) => incident.severity === 'warning').length;
  const total = payload.runtime.cache_hits + payload.runtime.cache_misses;
  const hitRatio = total === 0 ? 0 : Math.round((payload.runtime.cache_hits / total) * 100);

  return (
    <section className="diagnostics-panel">
      <header>
        <h2>Health center</h2>
        <p>Operational self-check for runtime quality and degradation signals.</p>
      </header>

      <div className="diagnostics-grid">
        <article>
          <small>Runtime mode</small>
          <strong>{payload.runtime.mode}</strong>
        </article>
        <article>
          <small>Cache hit ratio</small>
          <strong>{hitRatio}%</strong>
        </article>
        <article>
          <small>Incidents</small>
          <strong>{critical} critical / {warnings} warning</strong>
        </article>
        <article>
          <small>Failover</small>
          <strong>{payload.runtime.rpc_failover_active ? 'active' : 'standby'}</strong>
        </article>
      </div>
    </section>
  );
}
