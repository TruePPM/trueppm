import { useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { StubFieldset } from '../components/StubFieldset';
import { StubPageBanner } from '../components/StubPageBanner';

const EVENTS = [
  'Task assigned to me',
  'Task I own moves to another column',
  'Mention (@) in a comment',
  'Dependency change blocks my task',
  'Critical-path task slips',
  'Risk created or escalated',
  'Baseline saved',
  'Sprint started or closed',
  'Daily digest (9am local)',
];

const CHANNELS = ['Email', 'In-app', 'Slack', 'Mobile push'] as const;

type ToggleMatrix = boolean[][];

function buildDefaultMatrix(): ToggleMatrix {
  return EVENTS.map((_, i) =>
    CHANNELS.map((c, ci) => {
      if (c === 'Mobile push' && i > 5) return false;
      return (i + ci) % 3 !== 1;
    }),
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        on ? 'bg-brand-primary border-brand-primary' : 'bg-neutral-surface-sunken border-neutral-border',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
          on ? 'translate-x-3.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

/** Project > Notifications settings page. */
export function ProjectNotificationsPage() {
  const [matrix, setMatrix] = useState<ToggleMatrix>(buildDefaultMatrix);
  const [quietOn, setQuietOn] = useState(true);
  const [quietFrom, setQuietFrom] = useState('20:00');
  const [quietUntil, setQuietUntil] = useState('07:00');

  function toggle(row: number, col: number) {
    setMatrix((prev) =>
      prev.map((r, ri) => ri === row ? r.map((v, ci) => ci === col ? !v : v) : r),
    );
  }

  return (
    <>
    <StubPageBanner pageIssue={522} />
    <StubFieldset disabled>
    <div>
      <SettingsPageTitle
        title="Notifications"
        subtitle="Per-project routing rules. Members can override these in their personal preferences."
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        {/* Event × Channel matrix */}
        <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          {/* Header */}
          <div
            className="grid px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55 text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: `2fr repeat(${CHANNELS.length}, 110px)` }}
          >
            <span>Event</span>
            {CHANNELS.map((c) => (
              <span key={c} className="text-center">{c}</span>
            ))}
          </div>

          {EVENTS.map((evt, ri) => {
            return (
              <div
                key={evt}
                className={['grid items-center px-4 py-2.5 text-[13px]', ri < EVENTS.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
                style={{ gridTemplateColumns: `2fr repeat(${CHANNELS.length}, 110px)` }}
              >
                <span className="text-neutral-text-primary">{evt}</span>
                {CHANNELS.map((ch, ci) => {
                  const isQuiet = ch === 'Slack' && ri === 8;
                  return (
                    <span key={ch} className="flex justify-center">
                      {isQuiet ? (
                        <span className="text-[10px] font-semibold text-neutral-text-secondary tracking-wide">QUIET</span>
                      ) : (
                        <Toggle on={matrix[ri]?.[ci] ?? false} onToggle={() => toggle(ri, ci)} />
                      )}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Slack routing + Quiet hours */}
        <div className="grid grid-cols-2 gap-3.5">
          {/* Slack routing */}
          <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-3">Slack channel routing</h2>
            <div className="space-y-2">
              {[
                { lvl: 'Critical-path slips, risk escalations', ch: '#artemis-warroom' },
                { lvl: 'Daily digest, baseline events',         ch: '#artemis-pm' },
                { lvl: 'Comment mentions',                      ch: 'DM the recipient' },
              ].map((row) => (
                <div
                  key={row.ch}
                  className="grid gap-2.5 py-1.5 text-[12px]"
                  style={{ gridTemplateColumns: '1.4fr 1fr' }}
                >
                  <span className="text-neutral-text-secondary leading-snug">{row.lvl}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-brand-primary-light text-brand-primary h-fit">
                    {row.ch}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Quiet hours */}
          <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-3">Quiet hours</h2>
            <div className="flex items-center gap-2.5">
              <Toggle on={quietOn} onToggle={() => setQuietOn((v) => !v)} />
              <span className="text-[13px] text-neutral-text-primary">Suppress non-critical notifications</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <div>
                <div className="text-[11px] text-neutral-text-secondary mb-1">From</div>
                <div className="relative">
                  <select
                    value={quietFrom}
                    onChange={(e) => setQuietFrom(e.target.value)}
                    className="w-full h-8 pl-2.5 pr-7 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                  >
                    {['18:00', '19:00', '20:00', '21:00', '22:00'].map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <svg className="pointer-events-none absolute right-2 top-2.5 text-neutral-text-secondary" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-neutral-text-secondary mb-1">Until</div>
                <div className="relative">
                  <select
                    value={quietUntil}
                    onChange={(e) => setQuietUntil(e.target.value)}
                    className="w-full h-8 pl-2.5 pr-7 rounded border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                  >
                    {['06:00', '07:00', '08:00', '09:00'].map((t) => <option key={t}>{t}</option>)}
                  </select>
                  <svg className="pointer-events-none absolute right-2 top-2.5 text-neutral-text-secondary" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
              </div>
            </div>
            <p className="text-[12px] text-neutral-text-secondary mt-3 leading-snug">
              Critical-path slips and risk escalations always notify immediately.
            </p>
          </div>
        </div>
      </div>
    </div>
    </StubFieldset>
    </>
  );
}
