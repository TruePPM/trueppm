import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightVersions from "starlight-versions";
import rehypeMermaid from "rehype-mermaid";

// The "cut-off words" bug. Mermaid emits a single self-closed `<br />` inside
// each multi-line <foreignObject> label, but Astro's HTML serialization renders
// it as `<br></br>`. HTML parsers read the stray `</br>` as a SECOND start tag,
// so one intended break became two: every two-line label rendered three lines
// tall and clipped its last line out of the fixed-height (Mermaid-measured) box.
// It hit every multi-line label across the docs site.
//
// Rewriting the `<br>` to a raw void `<br>` does not survive — Astro's downstream
// raw-HTML pass re-parses it into a `br` element and re-serializes it doubled.
// So this plugin removes the `<br>` entirely: it splits each label element's
// children on the break and wraps each line in a `display:block` <span>, which
// stacks identically but serializes stably as `<span></span>` (no void-element
// ambiguity). Scoped to Mermaid SVGs (id `mermaid…`) so prose is untouched.
function rehypeFixMermaidLineBreaks() {
  const splitOnBr = (children) => {
    const lines = [[]];
    for (const c of children) {
      if (c.type === "element" && c.tagName === "br") lines.push([]);
      else lines[lines.length - 1].push(c);
    }
    return lines.map((line) => ({
      type: "element",
      tagName: "span",
      properties: { style: "display:block" },
      children: line,
    }));
  };
  const walk = (node, inMermaid) => {
    if (!node || !node.children) return;
    const isMermaidSvg =
      node.type === "element" &&
      node.tagName === "svg" &&
      typeof node.properties?.id === "string" &&
      node.properties.id.startsWith("mermaid");
    const within = inMermaid || isMermaidSvg;
    if (
      within &&
      node.children.some((c) => c.type === "element" && c.tagName === "br")
    ) {
      node.children = splitOnBr(node.children);
      return;
    }
    for (const child of node.children) walk(child, within);
  };
  return (tree) => walk(tree, false);
}

// Documentation versioning (starlight-versions) is intentionally DORMANT until
// the 0.4 (first beta) tag. The plugin snapshots the *current* docs tree, and
// that tree documents in-flight 0.4 work (MCP server, Jira import — pages that
// did not exist in 0.3). So the FIRST frozen version is cut at the 0.4 release,
// when the live tree IS the 0.4 docs. Freezing 0.3 from this tree would bake
// unshipped "Coming in 0.4" pages into a 0.3 snapshot — do not do it.
//
// To cut the first version at the 0.4 tag (one step, on `main`, after the
// release-status SSOT in src/content/_release-status.mdx reads "0.4 shipped"):
//   1. add the entry:  const versions = [{ slug: "0.4", label: "v0.4" }]
//   2. run `npm run build` once — on build the plugin (`ensureNewVersion` →
//      copyDirectory) archives the current docs into src/content/docs/0.4/ and
//      the live tree becomes "Next (unreleased)".
//   3. commit the generated src/content/docs/0.4/ snapshot.
// See the release checklist (contributing/release.md → "Cut the docs version").
//
// The guard below keeps the plugin unloaded while the array is empty (it errors
// on an empty `versions`), so the site ships unversioned until the first cut.
const versions = [];

const versionPlugins =
  versions.length > 0
    ? [starlightVersions({ versions, current: { label: "Next (unreleased)" } })]
    : [];

export default defineConfig({
  site: "https://docs.trueppm.com",
  // Build-time (SSR) Mermaid rendering (ADR-0198). `rehype-mermaid` renders each
  // ```mermaid fence to a static inline <svg> at build time using a headless
  // Chromium (Playwright) — the browser runs only on the build machine, so the
  // shipped HTML carries zero client-side JavaScript and makes no runtime network
  // fetch. `strategy: "inline-svg"` keeps the SVG nodes in the DOM so the diagram
  // is selectable, accessible, and stylable. Starlight's Expressive Code
  // intentionally ignores the `mermaid` language, leaving the fence for
  // rehype-mermaid to consume.
  //
  // Theme: a single `base` render with a design-system palette engineered to read
  // on BOTH the light (#ffffff) and dark (#17181c) page bodies. Starlight toggles
  // color modes via a `data-theme` attribute (not `prefers-color-scheme`), so
  // rehype-mermaid's `dark`/`<picture>` variant — which keys off the OS scheme —
  // would desync from a manual toggle; a single theme-agnostic palette avoids that
  // failure mode with zero client JS. Filled indigo nodes with white labels, and
  // neutral edges (gray-3 `#8b90a0`, identical in both modes), stay legible on
  // either background. See ADR-0198 for the rejected alternatives.
  markdown: {
    rehypePlugins: [
      [
        rehypeMermaid,
        {
          strategy: "inline-svg",
          mermaidConfig: {
            theme: "base",
            // Render node/edge labels as HTML (foreignObject) rather than SVG
            // <text>. SVG text labels ignore `<br/>` (collapsing multi-line
            // labels to their first line). HTML labels are laid out by the real
            // browser at build time and `<br/>` works. Mermaid only honors
            // htmlLabels when securityLevel is not "strict" (rehype-mermaid's
            // default); "loose" is safe here because the diagram source is
            // trusted repo markdown rendered at build time, never user input at
            // runtime.
            securityLevel: "loose",
            htmlLabels: true,
            flowchart: { htmlLabels: true, useMaxWidth: true },
            // Font choice is a CORRECTNESS constraint, not a style one. Boxes
            // are sized by measuring each label at BUILD time in the headless
            // Chromium (Ubuntu, `mcr.microsoft.com/playwright`), then the SVG
            // ships as fixed-width foreignObjects that a VISITOR's browser
            // repaints. If the build font is narrower than the paint font, every
            // label is clipped at the box edge — the recurring "cut-off words"
            // bug. `system-ui` is the worst possible choice here: it resolves to
            // a narrow Linux face at build but wide San Francisco on a Mac
            // visitor, so labels reliably clipped in production (a same-machine
            // Mac build did not reproduce it — only the cross-machine gap does).
            //
            // Fix: pin an Arial metric stack. The Playwright image ships
            // `fonts-liberation` (Liberation Sans is metric-identical to Arial
            // by design), every desktop OS has Arial, and Linux visitors fall to
            // Liberation — so build-measurement metrics equal paint metrics on
            // EVERY machine. Set at the top level (Mermaid measures with the
            // top-level `fontFamily`, default `arial,sans-serif`) AND mirrored in
            // themeVariables so the painted `.label` CSS resolves the same face.
            fontFamily: "Arial, Helvetica, sans-serif",
            themeVariables: {
              fontFamily: "Arial, Helvetica, sans-serif",
              // Filled accent nodes with white labels — reads on white and navy.
              primaryColor: "#3b5bdb",
              primaryBorderColor: "#c5d0f6",
              primaryTextColor: "#ffffff",
              // Neutral edges: gray-3 is the same hex in light and dark mode.
              lineColor: "#8b90a0",
              // Subgraph clusters and secondary nodes: transparent panel with a
              // neutral border so no light card is stamped onto the dark body.
              secondaryColor: "#3b5bdb",
              tertiaryColor: "transparent",
              clusterBkg: "transparent",
              clusterBorder: "#8b90a0",
              titleColor: "#8b90a0",
              nodeTextColor: "#ffffff",
              // Edge label chips: filled neutral with light text, legible on both.
              edgeLabelBackground: "#545867",
            },
          },
        },
      ],
      // MUST run after rehype-mermaid: repairs the `<br></br>` double-break the
      // serializer introduces into foreignObject labels (see above).
      rehypeFixMermaidLineBreaks,
    ],
  },
  integrations: [
    starlight({
      title: "TruePPM",
      tagline: "One data model for waterfall, agile, and hybrid programs.",
      // Default first-time visitors to light mode. Starlight has no
      // `defaultTheme` option; instead we seed localStorage before its
      // theme script reads it. Subsequent visits respect the user's choice.
      head: [
        {
          tag: "script",
          content:
            "if(!localStorage.getItem('starlight-theme')){localStorage.setItem('starlight-theme','light');document.documentElement.dataset.theme='light';}",
        },
      ],
      // logo: { alt: "TruePPM", src: "./src/assets/logo.svg" },
      social: [
        {
          icon: "gitlab",
          label: "GitLab",
          href: "https://gitlab.com/trueppm/trueppm",
        },
      ],
      editLink: {
        baseUrl:
          "https://gitlab.com/trueppm/trueppm/-/edit/main/packages/website/",
      },
      lastUpdated: true,
      disable404Route: true,
      // Trim the right-hand "On This Page" table of contents to h2 only. The
      // default (h2 + h3) produces a deep, indented column that eats horizontal
      // real estate on wide-content pages; h2-only keeps it a thin scan strip
      // without losing top-level in-page navigation.
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 2 },
      plugins: versionPlugins,
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        // --- Top-level overview ---
        {
          label: "Overview",
          items: [
            { slug: "overview" },
            { slug: "overview/why-now" },
            { slug: "overview/principles" },
            { slug: "overview/computed-not-guessed" },
            { slug: "overview/sso-is-not-enterprise" },
            { slug: "overview/team-ownership-not-surveillance" },
            { slug: "overview/roadmap" },
          ],
        },
        // --- The Story (canonical narrative — lands prospects + evaluators) ---
        {
          label: "The Story",
          items: [{ slug: "the-story" }],
        },
        // --- Getting Started (everyone) ---
        {
          label: "Getting Started",
          items: [
            // Installation + quickstart lead: they are the verified path today.
            // "Try it" (hosted demo + one-command trial) is demoted until its
            // zero-config paths go live with the 0.4 tag (#1775, #939).
            { slug: "getting-started/installation" },
            { slug: "getting-started/quickstart" },
            { slug: "getting-started/try-it" },
            { slug: "getting-started/sample-projects" },
            { slug: "getting-started/sample-project-tour" },
            { slug: "getting-started/evaluation-guide" },
            { slug: "getting-started/upgrade" },
          ],
        },
        // --- Persona guides ---
        {
          label: "Guides",
          items: [
            { slug: "guides/project-managers" },
            { slug: "guides/scrum-masters" },
            { slug: "guides/product-owners" },
            { slug: "guides/agile-coaches" },
            { slug: "guides/team-members" },
            { slug: "guides/resource-managers" },
            { slug: "guides/pmo-directors" },
            { slug: "guides/executives" },
          ],
        },
        // --- Administration ---
        {
          label: "Administration",
          items: [
            { slug: "administration/deployment" },
            { slug: "administration/sizing" },
            { slug: "administration/configuration" },
            { slug: "administration/admin-password" },
            { slug: "administration/rbac" },
            { slug: "administration/security" },
            { slug: "administration/project-settings" },
            { slug: "administration/management-commands" },
            { slug: "administration/data-export" },
            { slug: "administration/durability" },
            { slug: "administration/backup-restore" },
            { slug: "administration/redis-ha" },
            { slug: "administration/dead-letter-alerting" },
            { slug: "administration/system-health" },
            { slug: "administration/observability" },
            { slug: "administration/retention" },
            { slug: "administration/email" },
            { slug: "administration/msproject-configuration" },
            { slug: "administration/workspace-settings" },
            { slug: "administration/single-sign-on" },
            { slug: "administration/audit-log" },
            { slug: "administration/sharing-and-access" },
            { slug: "administration/attachment-policy" },
            { slug: "administration/working-calendars" },
            { slug: "administration/git-event-automation" },
            { slug: "administration/mcp-server" },
          ],
        },
        // --- Feature reference (sub-grouped) ---
        {
          label: "Features",
          items: [
            {
              label: "Foundations",
              collapsed: false,
              items: [
                { slug: "features/unified-data-model" },
                { slug: "features/interface" },
                { slug: "features/task-classification" },
                { slug: "features/methodology-preset" },
                { slug: "features/view-focus" },
                { slug: "features/timezone-and-date-format" },
                { slug: "features/programs" },
                { slug: "features/calendars" },
                { slug: "features/resources" },
              ],
            },
            {
              label: "Scheduling",
              collapsed: false,
              items: [
                { slug: "features/schedule" },
                { slug: "features/program-schedule" },
                { slug: "features/schedule-toolbar" },
                { slug: "features/schedule-build-mode" },
                { slug: "features/summary-tasks" },
                { slug: "features/subtasks" },
                { slug: "features/recurring-tasks" },
                { slug: "features/baselines" },
              ],
            },
            {
              label: "Agile",
              collapsed: false,
              items: [
                { slug: "features/product-backlog" },
                { slug: "features/board" },
                { slug: "features/labels" },
                { slug: "features/board-sharing" },
                { slug: "features/board-sprint-panel" },
                { slug: "features/flow-analytics" },
                { slug: "features/daily-standup" },
                { slug: "features/wip-overload" },
                { slug: "features/workshops" },
                { slug: "features/sprints" },
                { slug: "features/plan-sprint" },
                { slug: "features/estimation-poker" },
                { slug: "features/sprint-backlog" },
                { slug: "features/sprint-burndown" },
                { slug: "features/sprint-milestone-rollup" },
                { slug: "features/capacity-preflight" },
                { slug: "features/velocity" },
                { slug: "features/velocity-calibration" },
                { slug: "features/retrospective" },
                { slug: "features/my-work" },
                { slug: "features/timesheet" },
                { slug: "features/multi-team-lens" },
              ],
            },
            {
              label: "Reporting & Risk",
              collapsed: false,
              items: [
                { slug: "features/burn-charts" },
                { slug: "features/risk-register" },
                { slug: "features/monte-carlo" },
              ],
            },
            {
              label: "Collaboration",
              collapsed: false,
              items: [
                { slug: "features/real-time" },
                { slug: "features/task-collaboration" },
                { slug: "features/decisions" },
                { slug: "features/change-history" },
                { slug: "features/project-activity" },
                { slug: "features/assets" },
                { slug: "features/offline-sync" },
                { slug: "features/webhooks" },
                { slug: "features/inbound-task-sync" },
                { slug: "features/connected-accounts" },
                { slug: "features/personal-access-tokens" },
                { slug: "features/mcp-server" },
                { slug: "features/mcp-connect" },
                { slug: "features/agent-oversight" },
                { slug: "features/msproject-import-export" },
                { slug: "features/jira-import" },
              ],
            },
            {
              label: "Settings",
              collapsed: false,
              items: [
                { slug: "features/settings/project-members" },
                { slug: "features/settings/project-team" },
                { slug: "features/settings/signal-privacy" },
                { slug: "features/settings/project-notifications" },
                { slug: "features/settings/program-rollup" },
                { slug: "features/settings/program-risk-policy" },
              ],
            },
          ],
        },
        // --- API ---
        {
          label: "API",
          items: [
            { slug: "api/reference" },
            { slug: "api/stability" },
            { slug: "api/websockets" },
            { slug: "api/idempotency" },
          ],
        },
        // --- Scheduler Library (standalone PyPI package + platform integration) ---
        {
          label: "Scheduler Library",
          items: [
            { slug: "features/scheduler" },
            { slug: "integration/standalone" },
            { slug: "integration/django" },
            { slug: "integration/fastapi" },
          ],
        },
        // --- Architecture (evaluators + contributors) ---
        // ADRs are not mirrored here — they live at docs/adr/ in the monorepo.
        // The decisions page links out to the canonical location to avoid drift.
        {
          label: "Architecture",
          items: [
            { slug: "architecture/overview" },
            { slug: "architecture/ai-native" },
            { slug: "architecture/decisions" },
            { slug: "architecture/websocket-events" },
            { slug: "architecture/seed-data-schema" },
          ],
        },
        // --- Contributing ---
        {
          label: "Contributing",
          items: [
            { slug: "contributing/guide" },
            { slug: "contributing/ci-images" },
            { slug: "contributing/release" },
          ],
        },
        // --- About ---
        {
          label: "About",
          items: [{ slug: "about" }, { slug: "license" }],
        },
      ],
    }),
  ],
});
