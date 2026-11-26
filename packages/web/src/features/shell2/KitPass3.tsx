import { useState } from 'react';
import { Button } from '@/components/Button';
import { HeatGrid13 } from '@/components/page2/HeatGrid13';
import { ModalDialog } from '@/components/page2/ModalDialog';
import { NonHumanTile } from '@/components/page2/NonHumanTile';
import { SectionHeading } from '@/components/page2/PageTitle';
import { ReasonRadioGroup } from '@/components/page2/ReasonRadioGroup';
import { ScopeMatrix, type ScopeArea } from '@/components/page2/ScopeMatrix';
import { SplitBar } from '@/components/page2/SplitBar';
import { Stepper } from '@/components/page2/Stepper';
import { TrailTimeline } from '@/components/page2/TrailTimeline';
import { PAGE_BUTTON } from '@/components/page2/classes';

const WEEKS = Array.from({ length: 13 }, (_, i) =>
  new Date(Date.UTC(2026, 10, 2 + i * 7)).toISOString().slice(0, 10),
);
const LOADS = [30, 55, 70, 95, 110, 130, null, 80, 60, 45, 20, 100, 90];

const AREAS: ScopeArea[] = [
  {
    id: 'schedule',
    label: 'Schedule',
    covers: 'Tasks, dependencies and dates',
    access: { read: true, propose: true, write: false },
  },
  { id: 'budget', label: 'Budget', access: { read: true, propose: null, write: false } },
];

/** The Pass 3 half of the page-kit fixture (#4802): static data, no requests. */
export function KitPass3() {
  const [share, setShare] = useState(50);
  const [reason, setReason] = useState<string | null>(null);
  const [areas, setAreas] = useState(AREAS);
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="kit-actors" className="flex flex-col gap-2">
        <SectionHeading id="kit-actors">Non-human actors</SectionHeading>
        <div className="flex gap-2">
          <NonHumanTile kind="bot" label="Agent: triage bot" />
          <NonHumanTile kind="cpu" label="Service: scheduler" />
          <NonHumanTile kind="cog" label="Job: nightly forecast" />
          <NonHumanTile kind="hard-hat" label="Modeled seat" />
        </div>
      </section>
      <section aria-labelledby="kit-capacity" className="flex flex-col gap-3">
        <SectionHeading id="kit-capacity">Capacity</SectionHeading>
        <Stepper label="Allocation" value={share} onChange={setShare} step={10} />
        <SplitBar thisProject={50} otherProjects={30} unbooked={20} />
        <HeatGrid13
          label="Team load, next 13 weeks"
          weeks={WEEKS}
          startWeek={WEEKS[3]}
          definition="Booked hours as a share of working time."
          asOf="2026-11-02T00:00:00Z"
          rows={[{ id: 'ana', name: 'Ana Lee', loads: LOADS }]}
          modeledSeat={{ id: 'seat', name: 'Backend engineer', loads: LOADS }}
        />
      </section>
      <section aria-labelledby="kit-trail" className="flex flex-col gap-3">
        <SectionHeading id="kit-trail">Trail</SectionHeading>
        <TrailTimeline
          label="Change trail"
          entries={[
            {
              id: '1',
              who: (
                <>
                  <NonHumanTile kind="bot" label="Agent" size={22} />
                  Triage bot
                </>
              ),
              when: '12 Nov 2026',
              dateTime: '2026-11-12',
              reason: 'Scope added',
              words: 'The vendor added a review step.',
              deltas: ['Finish 4 Dec → 11 Dec', 'Float 3 → 0'],
            },
            { id: '2', who: 'Ana Lee', when: '13 Nov 2026', reason: 'Estimate was wrong' },
          ]}
        />
        <ReasonRadioGroup
          legend="Why did it move?"
          name="kit-reason"
          value={reason}
          onChange={setReason}
          options={[
            { value: 'scope', label: 'Scope added', hint: 'New work arrived' },
            { value: 'estimate', label: 'Estimate was wrong' },
          ]}
        />
        <ScopeMatrix
          label="Agent scope"
          areas={areas}
          columns={{ propose: { label: 'Dry run' }, write: { disabledReason: 'Ships in 0.6' } }}
          onChange={(id, access, granted) =>
            setAreas((prev) =>
              prev.map((a) =>
                a.id === id ? { ...a, access: { ...a.access, [access]: granted } } : a,
              ),
            )
          }
        />
        <div>
          <Button size="sm" className={PAGE_BUTTON} onClick={() => setOpen(true)}>
            Re-baseline
          </Button>
        </div>
        <ModalDialog
          open={open}
          onClose={() => setOpen(false)}
          title="Re-baseline"
          description="The new baseline is recorded in the trail."
          footer={
            <Button size="sm" className={PAGE_BUTTON} onClick={() => setOpen(false)}>
              Confirm
            </Button>
          }
        >
          <p className="text-sm text-p1-text-1">Nothing is saved in this fixture.</p>
        </ModalDialog>
      </section>
    </div>
  );
}
