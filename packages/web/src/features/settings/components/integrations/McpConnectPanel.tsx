/**
 * Shared MCP "connect an AI assistant" reveal panel (#1481, #1846).
 *
 * Rendered inside the one-time raw-token reveal for an `mcp:read` token, from
 * BOTH the project/program Integrations token surface (`ApiTokensManager`) and
 * the Personal Access Tokens page (`PersonalAccessTokensPage`). It was extracted
 * from `ApiTokensManager` so both surfaces share one implementation — the MCP
 * read surface admits only owner-scoped (personal) tokens
 * (`TokenIsOwnerScoped`, #1712), so the personal page is the canonical mint path
 * the docs point evaluators at, and it must offer the identical copy-paste
 * affordance rather than a second copy of it.
 *
 * The snippet's shape is the single source of truth for the config: the command
 * is `trueppm-mcp`, the env vars are `TRUEPPM_API_URL` (the instance origin; the
 * server appends `/api/v1`) and `TRUEPPM_API_TOKEN`. Keep it in step with
 * `docs/administration/mcp-server.md` and the `trueppm-mcp` package.
 */

import { useState } from 'react';
import { MCP_EXAMPLE_PROMPTS } from '@/lib/mcpExamplePrompts';

/**
 * Instance base URL the MCP server points at, derived from the browser origin.
 *
 * The web app talks to the API over the relative `/api/v1`, so the origin is
 * the self-hosted instance. `trueppm-mcp` appends `/api/v1` itself, so the
 * snippet must carry only the origin. Falls back to a placeholder when there is
 * no browser origin (server render / test env).
 */
export function instanceUrl(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return origin || 'https://your-trueppm-instance.example.com';
}

/**
 * Build the `claude_desktop_config.json` snippet. Kept as a pure, exported
 * helper so a unit test can assert the exact command / env / URL / token shape
 * against the `trueppm-mcp` package and the admin doc.
 */
export function buildClaudeDesktopConfig(apiUrl: string, token: string): string {
  const config = {
    mcpServers: {
      trueppm: {
        command: 'trueppm-mcp',
        env: {
          TRUEPPM_API_URL: apiUrl,
          TRUEPPM_API_TOKEN: token,
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

/**
 * One-time reveal for an `mcp:read` token: the raw token plus a copy-paste
 * `claude_desktop_config.json` snippet. The snippet's shape must stay in step
 * with `docs/administration/mcp-server.md` and the `trueppm-mcp` package — the
 * command is `trueppm-mcp`, the env vars are `TRUEPPM_API_URL` (the instance
 * origin; the server appends `/api/v1`) and `TRUEPPM_API_TOKEN`.
 */
export function McpConnectPanel({ token, onClose }: { token: string; onClose: () => void }) {
  const config = buildClaudeDesktopConfig(instanceUrl(), token);
  return (
    <>
      <h2 className="text-sm font-semibold text-neutral-text-primary mb-2" aria-live="polite">
        Token created — copy it now
      </h2>
      <p className="text-xs text-semantic-critical mb-3">
        This is the only time you&apos;ll see this token. Store it somewhere safe; it can&apos;t be
        retrieved again.
      </p>

      <label
        htmlFor="mcp-token-value"
        className="block mb-1 text-[12px] font-medium text-neutral-text-primary"
      >
        Your token
      </label>
      <div className="flex items-center gap-2 mb-4">
        <input
          id="mcp-token-value"
          readOnly
          value={token}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="New API token"
          className="tppm-mono flex-1 h-8 px-2 text-[12px] border border-neutral-border rounded bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        />
        <CopyButton value={token} label="Copy" accessibleName="Copy token" />
      </div>

      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Connect an AI assistant
        </span>
        <span className="h-px flex-1 bg-neutral-border/55" />
      </div>
      <p className="text-[12px] text-neutral-text-secondary mb-2">
        Add this to your MCP client&apos;s config — for Claude Desktop that&apos;s{' '}
        <span className="tppm-mono">claude_desktop_config.json</span> — then restart the client.
      </p>

      <div className="flex items-start gap-2 mb-3">
        <pre
          role="group"
          aria-label="claude_desktop_config.json snippet"
          className="tppm-mono flex-1 max-h-64 overflow-auto whitespace-pre px-3 py-2 text-[12px] border border-neutral-border rounded bg-neutral-surface-sunken text-neutral-text-primary"
        >
          {config}
        </pre>
        <CopyButton value={config} label="Copy config" accessibleName="Copy config" />
      </div>

      <McpTryAsking />

      <div className="flex items-center justify-between">
        <a
          href="https://docs.trueppm.com/administration/mcp-server"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded text-[12px] text-brand-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          MCP server setup →
        </a>
        <DoneButton onClose={onClose} />
      </div>
    </>
  );
}

/**
 * "Try asking:" — the curated example prompts (#1847). Once the client is wired
 * up, an evaluator's biggest question is "what do I type?" This surfaces the
 * canonical starter set from the shared single-source-of-truth constant, so the
 * connect dialog, the demo landing, and the docs never drift apart. Static copy,
 * no interaction — a labeled list, not a control.
 */
function McpTryAsking() {
  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-text-secondary">
          Try asking
        </span>
        <span className="h-px flex-1 bg-neutral-border/55" />
      </div>
      <ul className="space-y-1">
        {MCP_EXAMPLE_PROMPTS.map((prompt) => (
          <li key={prompt} className="flex gap-2 text-[12px] text-neutral-text-secondary">
            <span aria-hidden="true" className="text-brand-primary">
              &ldquo;
            </span>
            <span>{prompt}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keyboard-operable copy-to-clipboard button with a transient confirmation. */
export function CopyButton({
  value,
  label,
  accessibleName,
}: {
  value: string;
  label: string;
  accessibleName: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the value is selectable in its field */
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={accessibleName}
      className="h-8 px-3 shrink-0 rounded bg-brand-primary text-white text-[12px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

export function DoneButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="h-8 px-3 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      Done
    </button>
  );
}
