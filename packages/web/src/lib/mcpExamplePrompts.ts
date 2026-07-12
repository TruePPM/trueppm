/**
 * Curated "magic word" example prompts for the read-only MCP server (#1847).
 *
 * These are the natural-language questions an evaluator can paste into Claude
 * Desktop (or any MCP client) once TruePPM is connected — each one exercises a
 * tool the metered-connector agents can't answer, because it needs the CPM /
 * Monte Carlo engine, not a database read.
 *
 * SINGLE SOURCE OF TRUTH. This list is surfaced in-app in three places that must
 * stay identical:
 *   - the MCP connect success dialog (`McpConnectPanel` in
 *     `features/settings/components/integrations/ApiTokensManager.tsx`)
 *   - the public read-only demo landing (`PublicScheduleSharePage` in
 *     `features/share/`)
 *   - the docs site "Example prompts" section
 *     (`packages/website/src/content/docs/features/mcp-server.md`)
 *
 * The docs file cannot import from `packages/web`, so it carries a code comment
 * pointing back here. When you change a prompt, change BOTH sides in the same
 * commit so the product and the docs never drift.
 */
export const MCP_EXAMPLE_PROMPTS = [
  'Which of my projects are behind their P80 forecast?',
  'Show me the critical path for the Apollo project and how much slack the near-critical tasks have.',
  "What's on my plate this sprint?",
  'List the open high-impact risks for the Mercury program.',
  'What breaks if I slip the integration task 5 days?',
] as const;
