import { Navigate, useNavigate } from 'react-router';
import { useEdition } from '@/hooks/useEdition';
import { EnterpriseBadge } from '@/features/settings/components/EnterpriseBadge';

/** The 2×2-grid Portfolio glyph — shared with the Sidebar "Portfolio rollup" row
 *  so the page the user lands on visually echoes the affordance they clicked. */
function PortfolioGlyph({ className }: { className?: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M2 2h4v4H2V2zm6 0h4v4H8V2zM2 8h4v4H2V8zm6 0h4v4H8V8z" />
    </svg>
  );
}

/** A single governance-capability card in the value-prop grid. */
function CapabilityCard({ title, body }: { title: string; body: string }) {
  return (
    <li className="rounded-md border border-neutral-border bg-neutral-surface-raised p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-text-primary">
        <span aria-hidden="true" className="text-brand-primary">
          ◈
        </span>
        {title}
      </h2>
      <p className="mt-1 text-xs text-neutral-text-secondary">{body}</p>
    </li>
  );
}

/**
 * Community-edition upsell surface for the Enterprise Portfolio rollup (#1173,
 * web rule 177). The Sidebar "Portfolio rollup" row routes here under the
 * community edition instead of being hidden (reads as broken OSS) or being a
 * dead control (#669). Cross-program portfolio aggregation itself lives in the
 * enterprise repo and registers against the `nav.portfolio_section` / `routes`
 * slots (ADR-0029) — this OSS page is static marketing content only and queries
 * no portfolio data, keeping the Apache-2.0 boundary intact.
 *
 * Under the enterprise edition the real `/portfolio` route exists, so this page
 * redirects there. The redirect is gated on `useEdition().isLoading` because the
 * hook defaults to `'community'` while the query resolves — without the guard an
 * enterprise user would see a flash of the upsell before redirecting.
 */
export function PortfolioUpsellPage() {
  const { edition, isLoading } = useEdition();
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-text-secondary">
        Loading…
      </div>
    );
  }

  // Enterprise has the real portfolio view — never show the upsell there.
  if (edition === 'enterprise') {
    return <Navigate to="/portfolio" replace />;
  }

  return (
    <main className="min-h-full bg-app-canvas px-4 py-8 md:px-8">
      <section
        aria-labelledby="portfolio-upsell-heading"
        className="mx-auto max-w-3xl rounded-lg border border-neutral-border bg-neutral-surface px-6 py-8 md:px-8 md:py-10"
      >
        {/* Eyebrow — the focusable EnterpriseBadge link is correct on a marketing
            surface (rule 121); it self-gates and would return null under enterprise. */}
        <div className="mb-4 flex items-center gap-2">
          <EnterpriseBadge />
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
            Enterprise
          </span>
        </div>

        <h1
          id="portfolio-upsell-heading"
          className="flex items-center gap-3 font-display text-2xl font-bold text-neutral-text-primary"
        >
          <PortfolioGlyph className="shrink-0 text-brand-primary" />
          Portfolio rollup
        </h1>

        <p className="mt-3 max-w-prose text-sm leading-relaxed text-neutral-text-secondary">
          Roll every program up into one portfolio view — health, forecast, and resource demand
          across teams — with the governance an organization needs on top of an already-running
          practice.
        </p>

        <ul className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CapabilityCard
            title="Portfolio dashboard & health rollups"
            body="See every program's health and forecast in one place."
          />
          <CapabilityCard
            title="Cross-program resource leveling"
            body="Balance load and resolve contention across all your teams."
          />
          <CapabilityCard
            title="Approval workflows & demand intake"
            body="Govern what enters the portfolio and who signs off."
          />
          <CapabilityCard
            title="Rendered audit trail"
            body="An immutable, reviewable history for compliance."
          />
        </ul>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href="https://trueppm.com/enterprise"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Explore TruePPM Enterprise (opens in a new tab)"
            className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-sage-600 bg-sage-500 px-5 text-sm font-semibold text-navy-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-700 focus-visible:ring-offset-2 focus-visible:ring-offset-sage-500"
          >
            Explore TruePPM Enterprise
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M4 10l6-6M5 4h5v5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <button
            type="button"
            onClick={() => void navigate('/programs')}
            className="inline-flex h-10 items-center gap-1 px-2 text-sm font-medium text-brand-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            <span aria-hidden="true">←</span>
            Back to your programs
          </button>
        </div>
      </section>
    </main>
  );
}
