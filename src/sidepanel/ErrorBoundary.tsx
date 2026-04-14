import React from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[GenGuard] Unhandled error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
          <h2>Something went wrong</h2>
          <p style={{ color: '#666' }}>{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              cursor: 'pointer',
              borderRadius: 6,
              border: '1px solid #ccc',
              background: '#f5f5f5',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
