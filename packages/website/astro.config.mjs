import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightVersions from "starlight-versions";
import rehypeMermaid from "rehype-mermaid";

// When a release is cut, add an entry here. The plugin is only loaded when
// at least one version exists (it errors on an empty array).
// Example: { slug: "0.1.0", label: "v0.1.0" }
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
            // labels to their first line) and depend on Mermaid's own font-metric
            // measurement, which mis-sizes `system-ui` in the headless Chromium
            // renderer and clips the text at the box edge. HTML labels are laid
            // out by the real browser at build time, so boxes auto-size to their
            // content and `<br/>` works. Mermaid only honors htmlLabels when
            // securityLevel is not "strict" (rehype-mermaid's default); "loose"
            // is safe here because the diagram source is trusted repo markdown
            // rendered at build time, never user input at runtime.
            securityLevel: "loose",
            htmlLabels: true,
            flowchart: { htmlLabels: true, useMaxWidth: true },
            themeVariables: {
              fontFamily:
                "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
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
            { slug: "overview/roadmap" },
            { slug: "overview/sso-is-not-enterprise" },
          ],
        },
        // --- The Story (canonical narrative — lands prospects + evaluators) ---
        {
          label: "The Story",
          items: [
            { slug: "the-story" },
          ],
        },
        // --- Getting Started (everyone) ---
        {
          label: "Getting Started",
          items: [
            { slug: "getting-started/installation" },
            { slug: "getting-started/quickstart" },
            { slug: "getting-started/sample-projects" },
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
            { slug: "administration/retention" },
            { slug: "administration/email" },
            { slug: "administration/msproject-configuration" },
            { slug: "administration/workspace-settings" },
            { slug: "administration/audit-log" },
            { slug: "administration/sharing-and-access" },
            { slug: "administration/attachment-policy" },
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
                { slug: "features/offline-sync" },
                { slug: "features/webhooks" },
                { slug: "features/inbound-task-sync" },
                { slug: "features/connected-accounts" },
                { slug: "features/mcp-server" },
                { slug: "features/mcp-connect" },
                { slug: "features/msproject-import-export" },
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
