import type { Incident } from '../types';
import {
  MdAccessTimeFilled,
  MdCampaign,
  MdReportProblem,
  MdShield,
} from 'react-icons/md';
import { SkeletonTable } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';

type Props = {
  incidents?: Incident[];
  isLoading: boolean;
};

const toneMap: Record<Incident['severity'], 'healthy' | 'degraded' | 'critical'> = {
  info: 'healthy',
  warning: 'degraded',
  critical: 'critical',
};

export function IncidentsPage({ incidents, isLoading }: Props) {
  if (isLoading) {
    return <SkeletonTable rows={8} />;
  }

  if (!incidents) {
    return (
      <section className="page incidents-page">
        <div className="empty-state">Incidents are temporarily unavailable</div>
      </section>
    );
  }

  if (!incidents.length) {
    return (
      <section className="page">
        <div className="empty-state">Incident history is currently empty</div>
      </section>
    );
  }

  return (
    <section className="page incidents-page">
      <div className="incident-list">
        {incidents.map((incident) => (
          <article key={incident.id} className="incident-card">
            <div className="incident-card__stripe" data-tone={toneMap[incident.severity]} />
            <div className="incident-card__body">
              <header>
                <span className="incident-card__icon" data-tone={toneMap[incident.severity]}>
                  {incident.severity === 'critical' ? (
                    <MdReportProblem size={14} />
                  ) : incident.severity === 'warning' ? (
                    <MdShield size={14} />
                  ) : (
                    <MdCampaign size={14} />
                  )}
                </span>
                <StatusPill tone={toneMap[incident.severity]} label={incident.severity} />
                <code>{incident.code}</code>
                <span className="incident-card__time">
                  <MdAccessTimeFilled size={13} />
                  {new Date(incident.occurred_at).toLocaleString()}
                </span>
              </header>
              <h3>{incident.message}</h3>
              <p>{incident.details}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
