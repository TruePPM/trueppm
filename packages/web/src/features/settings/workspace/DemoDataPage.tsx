/**
 * Workspace > Demo data (#2490).
 *
 * "Load demo data" writes an entire program — projects, tasks, resources, a risk
 * register — on one click. This page is how you read what it will write *first*:
 * every bundled fixture listed with its scale, size and SHA-256, and a download
 * of the exact bytes the server will import.
 *
 * Deliberately NOT behind `RequireWorkspaceAdmin`, unlike the consolidated
 * `/settings` page: inspecting a listing of public, Apache-2.0 files requires no
 * authority, and gating it would strand every non-workspace-admin who follows
 * the "Inspect files" link from the demo loader — which any authenticated user
 * can see. Same reasoning as Trash (#1113): the page is readable, the mutation
 * inside it is gated by the API.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '@/components/EmptyState';
import { InboxIcon, WarningIcon } from '@/components/Icons';
import { SettingsShell, SettingsPageTitle, SettingsCard } from '../SettingsShell';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { buildWorkspaceNavGroups } from './workspaceNav';
import {
  useSampleCatalog,
  useLoadSampleProgram,
  type SampleInfo,
} from '@/hooks/useProgramSeedIo';

// Off-route shell, so the rail deep-links config sections back to the
// consolidated page. Fed from the shared builder so it cannot drift (#2013).
const NAV_GROUPS = buildWorkspaceNavGroups({ linked: true });

const ACTION_CLASS = [
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-control',
  'border border-neutral-border bg-neutral-surface-raised',
  'text-[12px] font-semibold text-neutral-text-primary',
  'hover:bg-neutral-surface-sunken focus:outline-none focus:ring-2',
  'focus:ring-brand-primary focus:ring-offset-1',
  'disabled:opacity-50 disabled:pointer-events-none',
].join(' ');

const PRIMARY_ACTION_CLASS = [
  'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-control',
  'border border-brand-primary bg-brand-primary text-[12px] font-semibold text-neutral-text-inverse',
  'hover:bg-brand-primary-dark focus:outline-none focus:ring-2',
  'focus:ring-brand-primary focus:ring-offset-1',
  'disabled:opacity-50 disabled:pointer-events-none',
].join(' ');

/** Bytes → "77.7 KB". Fixtures are KB-scale, so one decimal is the useful precision. */
export function formatBytes(bytes: number | null): string | null {
  if (typeof bytes !== 'number') return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * The digest, truncated to 8 characters with a copy affordance yielding all 64.
 *
 * Visible by default rather than behind a disclosure — an integrity claim you
 * have to go looking for reads as an afterthought. Typographically subordinate
 * (11px mono, secondary color) so it never competes with the counts, which are
 * what most readers came for.
 *
 * Copy yields the bare hex with no `sha256:` prefix and no whitespace, so it
 * pipes straight into a comparison against `sha256sum`.
 */
function HashChip({ sha256 }: { sha256: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 text-neutral-text-secondary">
      <span>sha256 {sha256.slice(0, 8)}…</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(sha256).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            },
            () => undefined,
          );
        }}
        className="text-brand-primary hover:underline focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 rounded-sm"
        aria-label={`Copy full SHA-256 for this file`}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

function StatusPill({ tone, children }: { tone: 'warn' | 'crit' | 'neutral'; children: string }) {
  // Full literal class strings per tone — never built dynamically, or Tailwind's
  // JIT purges the semantic colors and the pill renders unstyled.
  const cls =
    tone === 'warn'
      ? 'bg-semantic-at-risk-bg text-semantic-at-risk border-semantic-at-risk/40'
      : tone === 'crit'
        ? 'bg-semantic-critical-bg text-semantic-critical border-semantic-critical/40'
        : 'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border';
  return (
    <span
      className={`inline-flex items-center rounded-chip border px-2 py-0.5 font-mono text-[10px] font-semibold ${cls}`}
    >
      {children}
    </span>
  );
}

export function SampleRow({
  sample,
  onLoad,
  loading,
}: {
  sample: SampleInfo;
  onLoad: () => void;
  loading: boolean;
}) {
  const size = formatBytes(sample.size_bytes);
  // `typeof` rather than `!== null` so a response missing the key entirely
  // degrades to the "counts unavailable" row instead of rendering `undefined`.
  const hasCounts = typeof sample.project_count === 'number';

  return (
    <SettingsCard>
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[13.5px] font-semibold text-neutral-text-primary">
              {sample.title}
            </h3>
            {!sample.available ? (
              <StatusPill tone="crit">file missing</StatusPill>
            ) : !hasCounts ? (
              <StatusPill tone="warn">counts unavailable</StatusPill>
            ) : sample.schema_version ? (
              <StatusPill tone="neutral">{`schema ${sample.schema_version}`}</StatusPill>
            ) : null}
          </div>

          <p className="max-w-[62ch] text-[12.5px] text-neutral-text-secondary">
            {sample.available
              ? sample.description
              : 'Registered in this build but not present on disk. This installation may be incomplete — reinstall or report it.'}
          </p>

          {/* Order is fixed: counts, then size, then hash. Scale first, because
              that is the question most readers arrive with. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 font-mono text-[11px] text-neutral-text-secondary">
            {!sample.available ? (
              <span>{sample.filename}</span>
            ) : (
              <>
                {hasCounts ? (
                  <>
                    <span>
                      <b className="font-medium text-neutral-text-secondary">
                        {sample.project_count}
                      </b>{' '}
                      {sample.project_count === 1 ? 'project' : 'projects'}
                    </span>
                    <span>
                      <b className="font-medium text-neutral-text-secondary">{sample.task_count}</b>{' '}
                      tasks
                    </span>
                    <span>
                      <b className="font-medium text-neutral-text-secondary">
                        {sample.resource_count}
                      </b>{' '}
                      resources
                    </span>
                  </>
                ) : (
                  <span title="This instance couldn't summarize the file. You can still download it.">
                    —
                  </span>
                )}
                {size ? <span>{size}</span> : null}
                {sample.sha256 ? <HashChip sha256={sample.sha256} /> : null}
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 gap-2 sm:flex-col sm:gap-2">
          {/* href is the server-supplied download_url — never assembled from the
              key client-side, so the server stays the only thing that decides
              what a key maps to.

              A missing fixture renders a disabled <button>, not an <a> without
              an href: an anchor with no href has no link role, is not focusable
              and is announced as plain text, so a screen-reader user would never
              learn the action exists — let alone that it is unavailable. */}
          {sample.available ? (
            <a href={sample.download_url} download={sample.filename} className={ACTION_CLASS}>
              Download
            </a>
          ) : (
            <button type="button" disabled className={ACTION_CLASS}>
              Download
            </button>
          )}
          <button
            type="button"
            onClick={onLoad}
            disabled={!sample.available || loading}
            className={PRIMARY_ACTION_CLASS}
          >
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>
      </div>
    </SettingsCard>
  );
}

function SkeletonRow() {
  return (
    <SettingsCard>
      <div className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-[18px] w-52 animate-pulse rounded bg-neutral-surface-sunken" />
          <div className="h-[14px] w-full max-w-[46ch] animate-pulse rounded bg-neutral-surface-sunken" />
          <div className="h-[13px] w-64 animate-pulse rounded bg-neutral-surface-sunken" />
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <div className="h-8 w-[100px] animate-pulse rounded-control bg-neutral-surface-sunken" />
          <div className="h-8 w-[100px] animate-pulse rounded-control bg-neutral-surface-sunken" />
        </div>
      </div>
    </SettingsCard>
  );
}

/**
 * Names the asymmetry in-product, not just in the docs.
 *
 * A self-hoster who audits four files and believes he has audited all the demo
 * data has been misled by omission — which is precisely the trust gap this page
 * exists to close. Two demo programs build their data procedurally in Python and
 * have no file to download; saying so is part of the honesty, not a caveat to
 * bury.
 */
function ProceduralSeedNote() {
  return (
    <div className="mt-4 rounded-card border border-neutral-border bg-neutral-surface-sunken p-3">
      <p className="text-[12px] text-neutral-text-secondary">
        <b className="font-semibold text-neutral-text-primary">
          Two demo programs are not files.
        </b>{' '}
        <code className="font-mono text-[11px]">seed_demo_project</code> and{' '}
        <code className="font-mono text-[11px]">seed_ga_launch_program</code> build their data in
        Python, so there is nothing to download or verify for those two. The programs listed above
        are the inspectable ones.
      </p>
    </div>
  );
}

export function DemoDataPage() {
  const { data: workspace } = useWorkspaceSettings();
  const { samples, status, retry } = useSampleCatalog();
  const loadSample = useLoadSampleProgram();
  const navigate = useNavigate();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = (key: string) => {
    setPendingKey(key);
    setLoadFailed(false);
    loadSample.mutate(key, {
      onSuccess: (result) => {
        setPendingKey(null);
        void navigate(`/programs/${result.program.id}/overview`, {
          state: { startExploringSample: result.sample_key },
        });
      },
      onError: () => {
        setPendingKey(null);
        setLoadFailed(true);
      },
    });
  };

  return (
    <SettingsShell
      scope="workspace"
      scopeLinks={[
        { scope: 'workspace', label: 'Workspace', to: '/settings' },
        // Bundled fixtures are an instance-level fact — there is no program- or
        // project-scoped demo catalog, so hide the inapplicable scope segments
        // rather than disabling them (#2251).
        { scope: 'program', label: 'Program', to: null, hidden: true },
        { scope: 'project', label: 'Project', to: null, hidden: true },
      ]}
      contextName={workspace?.name ?? 'Workspace'}
      navGroups={NAV_GROUPS}
      exitTo="/"
      exitLabel="Home"
    >
      <SettingsPageTitle
        title="Demo data"
        subtitle="The sample programs bundled with this instance. Download a file to read it, or dry-run it through Import → Validate before importing."
      />
      <div className="max-w-[880px] px-4 pb-8 pt-4 sm:px-6">
        {status === 'loading' ? (
          // Row count is known from the shape of the registry, so reserve exactly
          // four — the counts land without a layout shift.
          <div className="space-y-2.5">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : status === 'error' ? (
          <EmptyState
            className="rounded-card border border-neutral-border bg-neutral-surface-raised"
            icon={WarningIcon}
            title="Couldn't load the sample list"
            description="The request to this instance's API failed. Downloads are unaffected once the list loads."
            action={
              <button type="button" onClick={retry} className={ACTION_CLASS}>
                Retry
              </button>
            }
          />
        ) : samples.length === 0 ? (
          <EmptyState
            className="rounded-card border border-neutral-border bg-neutral-surface-raised"
            icon={InboxIcon}
            title="No sample programs are bundled"
            description="This build ships without demo fixtures. You can still import your own file from Programs → Import."
          />
        ) : (
          <>
            {loadFailed && (
              <p role="alert" className="mb-3 text-[12px] text-semantic-critical">
                Could not load the demo — please try again.
              </p>
            )}
            <div className="space-y-2.5">
              {samples.map((sample) => (
                <SampleRow
                  key={sample.key}
                  sample={sample}
                  onLoad={() => load(sample.key)}
                  loading={pendingKey === sample.key}
                />
              ))}
            </div>
            <p className="mt-4 text-[12px] text-neutral-text-secondary">
              Verify a download with <code className="font-mono text-[11px]">sha256sum</code>. The
              hash proves you received the file this instance ships — not who wrote it.
            </p>
            <ProceduralSeedNote />
          </>
        )}
      </div>
    </SettingsShell>
  );
}
