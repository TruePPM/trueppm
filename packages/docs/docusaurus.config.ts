import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "TruePPM",
  tagline: "Open-core Project, Program, and Portfolio Management",
  favicon: "img/favicon.ico",

  url: "https://docs.trueppm.com",
  baseUrl: "/",

  organizationName: "trueppm",
  projectName: "trueppm",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://gitlab.com/trueppm/trueppm/-/edit/main/packages/docs/",
          routeBasePath: "/",
          showLastUpdateTime: true,
          showLastUpdateAuthor: false,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: "TruePPM",
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://gitlab.com/trueppm/trueppm",
          label: "GitLab",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Installation", to: "/getting-started/installation" },
            { label: "API Reference", to: "/api" },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "GitLab",
              href: "https://gitlab.com/trueppm/trueppm",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} TruePPM, Inc. Licensed under Apache 2.0.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "python", "typescript", "json", "yaml"],
    },
    colorMode: {
      defaultMode: "light",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
