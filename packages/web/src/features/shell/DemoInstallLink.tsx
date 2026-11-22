import { useDemoMode } from '@/hooks/useDemoMode';

/**
 * The evaluator's next step (#4116): a link to the installation guide, shown
 * only on the read-only demo. Shared by `DemoModeBar` (signed-in shell) and the
 * public share pages, which render outside the shell and are where a `/`
 * visitor lands on the demo (#3911). Text weight, not a CTA.
 *
 * Renders nothing while the edition read is unsettled or on a normal install
 * (a withdrawal, like the bar).
 */
export const DEMO_INSTALL_HREF = 'https://docs.trueppm.com/getting-started/installation/';

export function DemoInstallLinkAnchor({ className = '' }: { className?: string }) {
  return (
    <a
      href={DEMO_INSTALL_HREF}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="demo-install-link"
      className={`flex-shrink-0 whitespace-nowrap font-semibold underline underline-offset-2
        hover:no-underline rounded focus-visible:outline-none focus-visible:ring-2
        focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${className}`}
    >
      Install your own
    </a>
  );
}

export function DemoInstallLink({ className = '' }: { className?: string }) {
  const demo = useDemoMode();
  if (demo.isLoading || !demo.isDemoReadOnly) return null;
  return <DemoInstallLinkAnchor className={className} />;
}
