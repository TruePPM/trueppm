import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_EXAMPLE_PROMPTS } from './mcpExamplePrompts';

/**
 * Single-source-of-truth guard (#1847). The MCP example prompts are surfaced in
 * three places — the connect dialog, the demo landing, and the docs site — and
 * must never drift. The docs markdown can't import this constant, so this test
 * reads the real docs file and asserts every prompt appears there verbatim.
 * (vitest cwd = packages/web.)
 */
const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/lib
const docs = readFileSync(
  resolve(here, '../../../website/src/content/docs/features/mcp-server.md'),
  'utf8',
);

describe('MCP_EXAMPLE_PROMPTS', () => {
  it('offers a compact 4–5 prompt starter set', () => {
    expect(MCP_EXAMPLE_PROMPTS.length).toBeGreaterThanOrEqual(4);
    expect(MCP_EXAMPLE_PROMPTS.length).toBeLessThanOrEqual(5);
  });

  it('includes the what-if headliner no metered connector can answer', () => {
    expect(MCP_EXAMPLE_PROMPTS).toContain('What breaks if I slip the integration task 5 days?');
  });

  it('matches the docs "Example prompts" list verbatim (no silent fork)', () => {
    for (const prompt of MCP_EXAMPLE_PROMPTS) {
      expect(docs).toContain(prompt);
    }
  });
});
