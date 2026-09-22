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
        The Schedule is the only interactive part of this demo — drag a task and watch the
        critical path recompute live in your browser. Nothing you do here is saved.
      </p>
      <p className="text-xs leading-relaxed text-chrome-text-secondary">
        Everything else — boards, backlogs, sprints and resource plans — is real sample data to
        browse, not to try changes on. You can look, but nothing outside the Schedule responds to
        what you do.
      </p>
    </div>
  );
}
