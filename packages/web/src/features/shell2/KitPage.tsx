import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useFeatureFlag } from '@/lib/featureFlags';
import { supportCode } from '@/lib/supportCode';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { QueryErrorState } from '@/components/QueryErrorState';
import { PageFrame } from '@/components/page2/PageFrame';
import { PageTitle, SectionHeading } from '@/components/page2/PageTitle';
import { DataTable, type DataTableColumn } from '@/components/page2/DataTable';
import { Avatar, AvatarStack, UnassignedAvatar } from '@/components/page2/Avatar';
import { HealthBandChip, StatusChip, type StatusTone } from '@/components/page2/StatusChip';
import { NotComputable } from '@/components/page2/NotComputable';
import { DefinitionTip } from '@/components/page2/DefinitionTip';
import { FOCUS_RING, HIT_44 } from '@/components/page2/classes';
import { TYPE } from '@/components/page2/typeScale';
import { SHELL_V2_FLAG } from './ShellGate';

/**
 * The Pass 2 page-kit fixture (#4795): every primitive in `components/page2/`
 * and the three state variants, mounted inside the real shell with static
 * data. It is the reference the screen issues (#4796–#4800) build against and
 * the page the kit's Playwright spec drives. Behind `shell_v2`; with the flag
 * off it sends the person home.
 *
 * `?width=bleed` renders the full-bleed frame; `?filtered=1` shows a
 * "filters applied" row taking the toolbar's place.
 */
export function KitPage() {
  const v2 = useFeatureFlag(SHELL_V2_FLAG);
  if (!v2) return <Navigate to="/" replace />;
  return <KitPageBody />;
}

interface FixtureRow {
  id: string;
  name: string;
  tone: StatusTone;
  status: string;
  owners: { name: string }[];
  floatDays: number;
  finish: string;
}

const ROWS: FixtureRow[] = [
  {
    id: 'T-101',
    name: 'Cut over payments API',
    tone: 'critical',
    status: 'Critical path',
    owners: [{ name: 'Ana Lee' }],
    floatDays: 0,
    finish: '2026-12-04',
  },
  {
    id: 'T-102',
    name: 'Vendor contract review',
    tone: 'blocked',
    status: 'Blocked',
    owners: [{ name: 'Ben Ito' }, { name: 'Cy Park' }],
    floatDays: 2,
    finish: '2026-12-09',
  },
  {
    id: 'T-103',
    name: 'Load test the new cluster',
    tone: 'risk',
    status: 'Near-critical',
    owners: [
      { name: 'Dee Moss' },
      { name: 'Eli Ford' },
      { name: 'Fay Tan' },
      { name: 'Gus Ode' },
      { name: 'Hal Roy' },
    ],
    floatDays: 3,
    finish: '2026-12-11',
  },
  {
    id: 'T-104',
    name: 'Write the runbook',
    tone: 'info',
    status: 'In progress',
    owners: [],
    floatDays: 12,
    finish: '2026-12-18',
  },
  {
    id: 'T-105',
    name: 'Kickoff',
    tone: 'ok',
    status: 'Done',
    owners: [{ name: 'Ana Lee' }],
    floatDays: 0,
    finish: '2026-11-02',
  },
  {
    id: 'T-106',
    name: 'Decommission the old cluster',
    tone: 'neutral',
    status: 'Not started',
    owners: [],
    floatDays: 20,
    finish: '2027-01-15',
  },
];

const COLUMNS: DataTableColumn<FixtureRow>[] = [
  { key: 'name', header: 'Task', width: '240px', cell: (r) => r.name },
  {
    key: 'id',
    header: 'ID',
    width: '80px',
    cell: (r) => <span className={TYPE.mono}>{r.id}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    width: '140px',
    cell: (r) => <StatusChip tone={r.tone} label={r.status} />,
  },
  {
    key: 'owners',
    header: 'Owners',
    width: '140px',
    cell: (r) => <AvatarStack people={r.owners} size={22} />,
  },
  { key: 'float', header: 'Float (d)', width: '96px', numeric: true, cell: (r) => r.floatDays },
  { key: 'finish', header: 'Finish', width: '120px', numeric: true, cell: (r) => r.finish },
];

const TONES: { tone: StatusTone; label: string }[] = [
  { tone: 'critical', label: 'Critical path' },
  { tone: 'blocked', label: 'Blocked' },
  { tone: 'risk', label: 'Over WIP limit' },
  { tone: 'ok', label: 'Done' },
  { tone: 'info', label: 'In progress' },
  { tone: 'neutral', label: 'Not started' },
];

const noop = () => {};
/** Fixed so the fixture's support code is stable across runs. */
const FIXTURE_FAILED_AT = new Date('2026-11-07T09:15:00Z');

function KitPageBody() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const bleed = params.get('width') === 'bleed';
  const filtered = params.get('filtered') === '1';

  const toolbarButton = `inline-flex h-8 items-center rounded-md border border-p1-hairline px-3 text-[13px] text-p1-text-1 hover:bg-p1-surface-2 [@media(pointer:coarse)]:h-11 max-md:h-11 ${FOCUS_RING}`;

  return (
    <PageFrame
      width={bleed ? 'bleed' : 'contained'}
      header={
        <PageTitle
          back={{ label: 'Home', onBack: () => void navigate('/') }}
          description="Pass 2 page conventions, mounted with fixture data."
        >
          Page kit
        </PageTitle>
      }
      toolbar={
        <button type="button" className={toolbarButton} onClick={noop}>
          Filter
        </button>
      }
      toolbarOverride={
        filtered ? (
          <>
            <span className="text-[13px] text-p1-text-2">2 filters applied</span>
            <button type="button" className={toolbarButton} onClick={noop}>
              Clear filters
            </button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-8">
        <section aria-labelledby="kit-type" className="flex flex-col gap-2">
          <SectionHeading id="kit-type">Title scale</SectionHeading>
          <p className={TYPE.lead}>87%</p>
          <p className={TYPE.greeting}>Good morning, Ana</p>
          <p className={TYPE.tile}>12 tasks</p>
          <p className={`${TYPE.body} text-p1-text-1`}>Body text sits at 13 on 20.</p>
          <p className={`${TYPE.meta} text-p1-text-2`}>Meta text: updated 4 min ago</p>
          <p className={`${TYPE.mono} text-p1-text-2`}>T-101 · 2026-12-04 · 14.5</p>
        </section>

        <section aria-labelledby="kit-status" className="flex flex-col gap-2">
          <SectionHeading id="kit-status">Status chips</SectionHeading>
          <div className="flex flex-wrap gap-2">
            {TONES.map((t) => (
              <StatusChip key={t.tone} tone={t.tone} label={t.label} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <HealthBandChip band="on_track" />
            <HealthBandChip band="at_risk" />
            <HealthBandChip band="critical" />
          </div>
        </section>

        <section aria-labelledby="kit-people" className="flex flex-col gap-2">
          <SectionHeading id="kit-people">Avatars</SectionHeading>
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name="Ana Lee" size={22} />
            <Avatar name="Ana Lee" size={28} />
            <Avatar name="Ana Lee" size={36} />
            <AvatarStack people={ROWS[2].owners} />
            <UnassignedAvatar />
            <Avatar name="Ben Ito" overAllocatedPct={132} />
          </div>
        </section>

        <section aria-labelledby="kit-table" className="flex flex-col gap-2">
          <SectionHeading id="kit-table">Table</SectionHeading>
          <p className={`${TYPE.meta} text-p1-text-2`}>
            <DefinitionTip
              term="Float"
              definition="How many working days a task can slip before it moves the project finish."
              asOf="2026-11-07T09:00:00Z"
            />
          </p>
          <DataTable
            caption="Fixture tasks"
            columns={COLUMNS}
            rows={ROWS}
            rowKey={(r) => r.id}
            className="max-h-[320px]"
          />
          <NotComputable
            label="Schedule variance"
            missing="no baseline is set"
            fix={
              <button
                type="button"
                onClick={noop}
                className={`${HIT_44} rounded font-medium text-p1-text-1 underline ${FOCUS_RING}`}
              >
                Set a baseline
              </button>
            }
          />
        </section>

        <section aria-labelledby="kit-loading" className="flex flex-col gap-2">
          <SectionHeading id="kit-loading">Loading</SectionHeading>
          <LoadingSkeleton
            variant="table"
            label="Loading tasks…"
            columns={COLUMNS}
            count="24 tasks"
            rows={3}
          />
        </section>

        <section aria-labelledby="kit-empty">
          <SectionHeading id="kit-empty">Empty</SectionHeading>
          <EmptyState
            variant="page"
            title="No risks logged yet"
            description="Risks you log here feed the forecast and the health band."
            actions={[
              <Button key="add" size="sm" onClick={noop}>
                Log a risk
              </Button>,
              <Button key="import" size="sm" variant="secondary" onClick={noop}>
                Import from CSV
              </Button>,
            ]}
          />
        </section>

        <section aria-labelledby="kit-error">
          <SectionHeading id="kit-error">Error</SectionHeading>
          <QueryErrorState
            variant="page"
            message="The risk register couldn't load."
            stillWorks="The schedule, board and your tasks still work; only this list is down."
            supportCode={supportCode(undefined, FIXTURE_FAILED_AT)}
            onRetry={noop}
          />
        </section>
      </div>
    </PageFrame>
  );
}
