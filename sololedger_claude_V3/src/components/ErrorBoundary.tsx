import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches render/lifecycle errors anywhere in the tree and shows a friendly
 * fallback instead of a blank screen. Stack traces are logged to the console
 * only — never surfaced to the user.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log for debugging only — the user-facing fallback stays generic.
    console.error('Unexpected application error:', error, info.componentStack);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-ink px-4">
          <div className="w-full max-w-md rounded-lg border border-ink-700 bg-ink-800 p-6 text-center shadow-card">
            <h1 className="text-base font-semibold text-ink-950">Something went wrong</h1>
            <p className="mt-2 text-sm text-mist-400">
              The app hit an unexpected error. Your data is stored locally and is safe —
              reloading usually fixes this.
            </p>
            <Button className="mt-5 w-full" onClick={this.handleReload}>
              Reload app
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
