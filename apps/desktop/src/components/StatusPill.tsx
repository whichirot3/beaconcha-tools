import clsx from 'clsx';

type Props = {
  tone: 'healthy' | 'degraded' | 'critical' | 'neutral';
  label: string;
};

export function StatusPill({ tone, label }: Props) {
  return <span className={clsx('status-pill', `status-pill--${tone}`)}>{label}</span>;
}
