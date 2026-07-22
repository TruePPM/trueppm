import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '@/lib/telemetry';

interface Props {
  /** Section title — shown in the fallback so the user knows which one failed. */
  sectionTitle: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-time errors in a single drawer section so a buggy section
 * (OSS or Enterprise-registered) cannot crash the surrounding drawer chrome.
 *
 * ADR-0050 §Decision §Error containment: each registered section is wrapped
 * in this boundary; render failure produces a contained "Section unavailable"
 * message with a Retry button that resets the boundary state.
 */
export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reuse the existing client error sink — the global app-level boundary
    // logs to the same channel.
    if (typeof window !== 'undefined' && 'console' in window) {
      console.error(
        `[SectionErrorBoundary] section "${this.props.sectionTitle}" failed:`,
        error,
        info.componentStack,
      );
    }
    // Report to the operator's collector (no-op unless configured).
    reportError(error, { boundary: `section:${this.props.sectionTitle}` });
  }

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 px-3 py-4 text-sm
            text-neutral-text-secondary"
        >
          <span>Section unavailable.</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="px-2 py-1 rounded-control text-xs border border-neutral-border
              text-neutral-text-primary hover:bg-neutral-surface-raised
              focus:outline-none focus:ring-2
              focus:ring-brand-primary focus:ring-offset-1"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
