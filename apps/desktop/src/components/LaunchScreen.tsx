import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react';
import type { LaunchStep } from '../hooks/useLaunchChecks';

type Props = {
  steps: LaunchStep[];
  progress: number;
  checksCompleted: boolean;
  manualMode: boolean;
  onNext: () => void;
};

function iconFor(state: LaunchStep['state']) {
  switch (state) {
    case 'ok':
      return <CheckCircle2 size={17} strokeWidth={2.1} />;
    case 'error':
      return <AlertTriangle size={17} strokeWidth={2.1} />;
    case 'running':
      return <CircleDashed size={17} strokeWidth={2.1} className="launch-step__spin" />;
    default:
      return <CircleDashed size={17} strokeWidth={2.1} />;
  }
}

export function LaunchScreen({
  steps,
  progress,
  checksCompleted,
  manualMode,
  onNext,
}: Props) {
  return (
    <div className="launch-screen" role="status" aria-live="polite">
      <div className="launch-grid">
        <section className="launch-hero">
          <img src="/icon.png" alt="Beaconcha Tools logo" className="launch-logo" />
          <h1>Beaconcha Tools Control Plane</h1>
          <p>
            Connecting Beacon/Execution sources, validating cache, and starting local runtime.
          </p>

          <div className="launch-progress">
            <div className="launch-progress__bar" style={{ width: `${progress}%` }} />
          </div>
          <strong className="launch-progress__label">{progress}% initialized</strong>

          {manualMode ? (
            <button
              type="button"
              className="launch-next"
              onClick={onNext}
              disabled={!checksCompleted}
            >
              Next
            </button>
          ) : null}

          {manualMode ? (
            <small className="launch-dev-hint">
              DEV mode: auto-advance is disabled, you can stay on the splash screen.
            </small>
          ) : null}
        </section>

        <section className="launch-steps-panel">
          <h2>Startup checks</h2>
          <ul className="launch-steps">
            {steps.map((step) => (
              <li key={step.id} className={`launch-step launch-step--${step.state}`}>
                <span className="launch-step__icon">{iconFor(step.state)}</span>
                <div>
                  <strong>{step.label}</strong>
                  <small>{step.details ?? 'Waiting...'}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
