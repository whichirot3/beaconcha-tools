import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logUi } from '../lib/logger';

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class AppCrashBoundary extends Component<Props, State> {
  state: State = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep stack traces in devtools/terminal logs for quick diagnostics.
    console.error('AppCrashBoundary', error, info.componentStack);
    logUi('error', 'ui.crash_boundary', error.message, {
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  private resetAndReload = () => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('beaconops_') || key.startsWith('beaconcha_')) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // localStorage may be inaccessible in restricted environments.
    }

    window.location.reload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '16px',
          background: '#121614',
          color: '#e7ece6',
          fontFamily: 'Quantico, Segoe UI, sans-serif',
        }}
      >
        <section
          style={{
            width: 'min(680px, 100%)',
            border: '1px solid #2a322c',
            borderRadius: '10px',
            padding: '16px',
            background: '#1a211d',
            display: 'grid',
            gap: '10px',
          }}
        >
          <strong style={{ fontSize: '1.08rem' }}>Beaconcha Tools UI error</strong>
          <span style={{ color: '#a9b2aa', fontSize: '0.86rem' }}>
            The app hit a critical render error and halted the screen.
          </span>
          <code
            style={{
              display: 'block',
              padding: '10px',
              borderRadius: '8px',
              border: '1px solid #2f3a33',
              background: '#101512',
              color: '#d6dcd4',
              fontSize: '0.78rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error.message}
          </code>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                borderRadius: '8px',
                border: '1px solid #3b493f',
                background: '#263128',
                color: '#f3f6f2',
                padding: '8px 12px',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.resetAndReload}
              style={{
                borderRadius: '8px',
                border: '1px solid #615437',
                background: '#3a3222',
                color: '#f8e4b4',
                padding: '8px 12px',
                cursor: 'pointer',
              }}
            >
              Reset local state
            </button>
          </div>
        </section>
      </div>
    );
  }
}
