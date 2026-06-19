import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Section id — shown in the fallback so the user knows which one failed. */
  sectionId: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Catches render-time errors in a single settings section (ADR-0146, issue 1248).
 *
 * The consolidated settings page mounts every `<SettingsSection>` at once, so —
 * unlike the old per-route shell where only the active section was mounted — a
 * single section throwing during render would otherwise be caught by the root
 * router boundary and replace the ENTIRE app. Wrapping each section contains the
 * blast radius: one broken/partial section degrades to a contained "Section
 * unavailable" message with Retry, and the rest of the page (including the save
 * bar and other dirty sections) stays interactive.
 *
 * Mirrors the drawer-section pattern (ADR-0050 §Error containment).
 */
export class SettingsSectionErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof window !== 'undefined' && 'console' in window) {
      console.error(
        `[SettingsSectionErrorBoundary] section "${this.props.sectionId}" failed:`,
        error,
        info.componentStack,
      );
    }
  }

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 px-6 py-8 text-sm text-neutral-text-secondary border-b border-neutral-border/55"
        >
          <span>This section is unavailable. The rest of your settings are unaffected.</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="px-2.5 py-1 rounded text-xs border border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
