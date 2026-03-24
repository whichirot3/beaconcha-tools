import { render, screen } from '@testing-library/react';
import { LaunchScreen } from './LaunchScreen';

describe('LaunchScreen', () => {
  it('shows progress, checks and next button in manual mode', () => {
    render(
      <LaunchScreen
        progress={50}
        checksCompleted={true}
        manualMode={true}
        onNext={() => undefined}
        steps={[
          { id: 'rpc', label: 'RPC', state: 'ok', details: 'ok' },
          { id: 'cache', label: 'Cache', state: 'running' },
        ]}
      />
    );

    expect(screen.getByText('Beaconcha Tools Control Plane')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(screen.getByText('RPC')).toBeInTheDocument();
    expect(screen.getByText('Cache')).toBeInTheDocument();
  });
});
