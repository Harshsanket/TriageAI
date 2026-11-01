import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button, Notice } from './index';

interface Props {
  children: ReactNode;
  /** Change this to reset a crashed boundary (e.g. the current route). */
  resetKey?: string;
  /** Shown in the card so operators know which area failed. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * A crash in one module page must not blank the whole shell (10C.T7). The
 * card offers retry and copy-details (the message and stack stay local; only
 * the operator copies them on purpose).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[triageai] page crashed', error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  private copy = (): void => {
    const error = this.state.error;
    if (!error) return;
    const text = `${error.name}: ${error.message}\n\n${error.stack ?? ''}`;
    void globalThis.navigator?.clipboard?.writeText?.(text);
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Notice tone="error" onDismiss={() => this.setState({ error: null })}>
        <strong>{this.props.label ?? 'This page'} hit an unexpected error.</strong>
        <p className="ui-notice__meta">{this.state.error.message}</p>
        <div className="ui-row">
          <Button variant="primary" onClick={() => this.setState({ error: null })}>
            Retry
          </Button>
          <Button variant="ghost" onClick={this.copy}>
            Copy details
          </Button>
        </div>
      </Notice>
    );
  }
}
