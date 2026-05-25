import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightVersions from "starlight-versions";

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
      plugins: versionPlugins,
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        // --- Top-level overview ---
        {
          label: "Overview",
          items: [
            { slug: "overview" },
            { slug: "overview/roadmap" },
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
            { slug: "guides/team-members" },
            { slug: "guides/resource-managers" },
            { slug: "guides/executives" },
          ],
        },
        // --- Administration ---
        {
          label: "Administration",
          items: [
            { slug: "administration/deployment" },
            { slug: "administration/configuration" },
            { slug: "administration/admin-password" },
            { slug: "administration/rbac" },
            { slug: "administration/security" },
            { slug: "administration/project-settings" },
            { slug: "administration/management-commands" },
            { slug: "administration/durability" },
            { slug: "administration/dead-letter-alerting" },
            { slug: "administration/retention" },
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
                { slug: "features/methodology-preset" },
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
                { slug: "features/schedule-toolbar" },
                { slug: "features/schedule-build-mode" },
                { slug: "features/summary-tasks" },
                { slug: "features/subtasks" },
                { slug: "features/baselines" },
              ],
            },
            {
              label: "Agile",
              collapsed: false,
              items: [
                { slug: "features/board" },
                { slug: "features/board-sprint-panel" },
                { slug: "features/wip-overload" },
                { slug: "features/workshops" },
                { slug: "features/sprints" },
                { slug: "features/plan-sprint" },
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
              ],
            },
            {
              label: "Collaboration",
              collapsed: false,
              items: [
                { slug: "features/real-time" },
                { slug: "features/task-collaboration" },
                { slug: "features/change-history" },
                { slug: "features/offline-sync" },
                { slug: "features/webhooks" },
                { slug: "features/inbound-task-sync" },
              ],
            },
          ],
        },
        // --- API ---
        {
          label: "API",
          items: [{ slug: "api/reference" }],
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
          ],
        },
        // --- Contributing ---
        {
          label: "Contributing",
          items: [
            { slug: "contributing/guide" },
            { slug: "contributing/release" },
          ],
        },
        // --- About ---
        {
          label: "About",
          items: [{ slug: "about" }],
        },
      ],
    }),
  ],
});
