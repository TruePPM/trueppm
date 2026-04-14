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
      tagline: "Open-source project scheduling that actually computes the math.",
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
        // --- Getting Started (everyone) ---
        {
          label: "Getting Started",
          items: [
            { slug: "getting-started/installation" },
            { slug: "getting-started/quickstart" },
          ],
        },
        // --- Persona guides ---
        {
          label: "Guides",
          items: [
            { slug: "guides/project-managers" },
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
            { slug: "administration/rbac" },
            { slug: "administration/security" },
          ],
        },
        // --- Feature reference ---
        {
          label: "Features",
          items: [
            { slug: "features/scheduler" },
            { slug: "features/gantt" },
            { slug: "features/real-time" },
            { slug: "features/offline-sync" },
          ],
        },
        // --- API + integrations ---
        {
          label: "API",
          items: [{ slug: "api/reference" }],
        },
        // --- Integration guides ---
        {
          label: "Integration",
          items: [
            { slug: "integration/standalone" },
            { slug: "integration/django" },
            { slug: "integration/fastapi" },
          ],
        },
        // --- Architecture (evaluators + contributors) ---
        {
          label: "Architecture",
          items: [
            { slug: "architecture/overview" },
            {
              label: "ADRs",
              autogenerate: { directory: "architecture/adr" },
            },
          ],
        },
        // --- Contributing ---
        {
          label: "Contributing",
          items: [{ slug: "contributing/guide" }],
        },
      ],
    }),
  ],
});
