/**
 * The read-only demo's announcement on the login screen's marketing panel
 * (ADR-1197 D3, #3926).
 *
 * Says what the demo *is* before the visitor signs in, and scopes the promise
 * honestly. The two paragraphs are deliberately asymmetric, not just factually
 * distinct: the first names the Schedule as the demo's *only* interactive surface
 * (it recomputes the CPM cascade live, in the browser), and the second explicitly
 * says everything else — boards, backlogs, sprints, resource plans — is sample data
 * to browse, not a workspace to try things in. Pitching both in the same inviting
 * tone is what turns a Product Owner's first click on the backlog into disappointment
 * rather than an informed choice (#3970) — which is itself a milder version of the
 * "product is broken" failure D3's refusal copy exists to prevent.
 *
 * The last three paragraphs head off two conclusions the demo's own shape invites
 * (#3998). Every visitor signs in as one shared account with `/ws/` closed, so the
 * demo cannot show presence or live edits — without saying so, a visitor reads the
 * absence as "TruePPM has no collaboration" rather than "this demo can't show it",
 * and the fix is to point them at a local install where it works. And the demo
 * account's throttles are lifted (ADR-1197 D6: a per-account bucket shared by every
 * visitor only decides when the whole demo fails at once), so the note says the
 * product throttles normally — otherwise a security-minded evaluator infers there
 * is no rate limiting at all.
 *
 * `relative` is required: the panel's decorative grid `<svg>` is `absolute inset-0`,
 * and both existing children carry it for the same reason.
 */
export function DemoModePanelNote() {
  return (
    <div className="relative rounded-card border border-chrome-border bg-chrome-surface-raised p-4 max-w-sm flex flex-col gap-2">
      {/* A real heading, not a bold div: it reads as one, and a screen-reader user
          browsing this page's headings would otherwise skip the whole block. `h2`
          sits under the form column's `h1` and beside the panel's own `h2`. */}
      <h2 className="inline-flex items-center gap-1.5 text-sm font-semibold text-chrome-text-primary">
        <span aria-hidden="true">◆</span> Read-only demo
      </h2>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        The Schedule is the only interactive part of this demo — drag a task and watch the critical
        path recompute live in your browser. Nothing you do here is saved.
      </p>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        Everything else — boards, backlogs, sprints and resource plans — is real sample data to
        browse, not to try changes on. You can look, but nothing outside the Schedule responds to
        what you do.
      </p>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        Everyone shares this one login, so you won&apos;t see other people online or their live
        edits — this demo shows the interface, not collaboration. To try that, we strongly recommend
        installing TruePPM yourself with Docker Compose or the Helm chart.{' '}
        <a
          href="https://docs.trueppm.com/getting-started/installation/"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-chrome-text-primary underline underline-offset-2 hover:no-underline rounded
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Installation guide <span className="sr-only">(opens in a new tab)</span>
        </a>
      </p>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        Rate limits are lifted for this demo account only. Throttling is built into TruePPM and on
        by default in every regular install.
      </p>
    </div>
  );
}
