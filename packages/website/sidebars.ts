import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "Getting Started",
      items: [
        "getting-started/installation",
        "getting-started/quickstart",
      ],
    },
    {
      type: "category",
      label: "Architecture",
      items: ["architecture/overview"],
    },
    {
      type: "category",
      label: "Features",
      items: [
        "features/scheduler",
        "features/gantt",
        "features/rbac",
        "features/real-time",
        "features/offline-sync",
      ],
    },
    "api/index",
    {
      type: "category",
      label: "ADRs",
      items: ["adr/0003-rbac-auto-scheduling-websockets"],
    },
  ],
};

export default sidebars;
