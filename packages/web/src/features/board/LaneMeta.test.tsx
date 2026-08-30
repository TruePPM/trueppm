import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LaneMeta } from './LaneMeta';
import { ROW_VOCABULARY, countRows } from '@/features/schedule/rowVocabulary';

// `committedTaskCount` is explicit on purpose: since #3148 omitting it means
// ZERO, not `taskCount`, so a fixture that leaves it out is describing an
// uncommitted lane whether or not it meant to.
const BASE_PROPS = {
  phaseId: 'phase-1',
  phaseName: 'Engineering',
  avgProgress: 55,
  taskCount: 8,
  committedTaskCount: 4,
  railColor: '#3E8C6D',
};

/**
 * The uncommitted slot's accessible name. It is also what separates the
 * progress em-dash from the cost row's em-dash, which is why assertions key on
 * it rather than on the glyph.
 */
const NO_PROGRESS = 'Phase progress: not applicable — no committed work in this phase';

describe('LaneMeta', () => {
  it('renders phase name', () => {
    render(<LaneMeta {...BASE_PROPS} />);
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('renders the count in the committed noun — plural', () => {
    render(<LaneMeta {...BASE_PROPS} taskCount={8} />);
    expect(screen.getByText('8 items')).toBeInTheDocument();
  });

  it('renders the count in the committed noun — singular', () => {
    render(<LaneMeta {...BASE_PROPS} taskCount={1} committedTaskCount={1} />);
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('clamps progress to 0–100 — upper bound', () => {
    render(<LaneMeta {...BASE_PROPS} avgProgress={150} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('clamps progress to 0–100 — lower bound', () => {
    // A negative rollup would otherwise reach `style.width` as `-20%`, which is
    // not a valid track width, and `aria-valuenow` as a value outside the
    // declared min/max.
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={-20} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(container.querySelector<HTMLElement>('[role="progressbar"] > div')?.style.width).toBe(
      '0%',
    );
  });

  it('renders add-task button with correct aria-label', () => {
    render(<LaneMeta {...BASE_PROPS} onAddTask={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add task to Engineering' })).toBeInTheDocument();
  });

  it('calls onAddTask when + is clicked', () => {
    const onAddTask = vi.fn();
    render(<LaneMeta {...BASE_PROPS} onAddTask={onAddTask} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add task to Engineering' }));
    expect(onAddTask).toHaveBeenCalledTimes(1);
  });

  // #2208 / WCAG 2.5.5 rule 5: the 22px add-task control carries an invisible
  // before-pad expander so its touch target reaches 44px.
  it('gives the add-task button a 44px touch target via before-pad', () => {
    render(<LaneMeta {...BASE_PROPS} onAddTask={vi.fn()} />);
    const cls = screen.getByRole('button', { name: 'Add task to Engineering' }).className;
    expect(cls).toContain('relative');
    expect(cls).toContain("before:inset-[-11px]");
  });

  // #324: assignee-grouped lanes pass no onAddTask — a lane id there is a
  // resource, not a parent — so the add affordance is suppressed (not dead).
  it('suppresses the add-task button when onAddTask is omitted', () => {
    render(<LaneMeta {...BASE_PROPS} />);
    expect(
      screen.queryByRole('button', { name: 'Add task to Engineering' }),
    ).not.toBeInTheDocument();
  });

  // #1965: progress magnitude uses the neutral sage fill, NOT the health
  // palette. The old amber-below-50 → green-above-50 flip conflated progress
  // with health (web-rule 7); an early-but-healthy lane must not read as amber.
  it('progress bar fill uses brand-primary (sage) regardless of magnitude (issue #1965)', () => {
    for (const avg of [10, 49, 50, 90, 100]) {
      const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={avg} />);
      const bar = container.querySelector('[role="progressbar"] > div');
      expect(bar?.className).toContain('bg-brand-primary');
    }
  });

  it('progress bar fill never uses a semantic health token for magnitude (issue #1965)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={49} />);
    const bar = container.querySelector('[role="progressbar"] > div');
    expect(bar?.className).not.toContain('bg-semantic-on-track');
    expect(bar?.className).not.toContain('bg-brand-accent');
  });

  it('progress bar track is h-1.5 for pre-attentive color mass (issue #1965)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={42} />);
    const track = container.querySelector('[role="progressbar"]');
    expect(track?.className).toContain('h-1.5');
  });

  it('progress bar width matches avgProgress (issue #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={42} />);
    const bar = container.querySelector<HTMLElement>('[role="progressbar"] > div');
    expect(bar?.style.width).toBe('42%');
  });

  it('progress bar exposes aria-valuenow with the percent (issue #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={37} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('37');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
  });

  it('renders em-dash instead of 0% when there are no committed tasks (ADR-0057)', () => {
    const { container } = render(
      <LaneMeta {...BASE_PROPS} taskCount={0} committedTaskCount={0} avgProgress={0} />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    // `queryByText('0%')` would be vacuous here — the pre-#3148 component also
    // took the em-dash branch on this fixture and never rendered "0%". Deny the
    // whole numeral shape instead, which is the claim that actually changed.
    expect(container.textContent).not.toMatch(/\d+%/);
  });

  it('em-dash empty state triggers when committedTaskCount is 0 even with cards present', () => {
    // Lane has cards (taskCount=4) but none are committed (no plannedStart).
    // The counter still reads the total — and names it `ideas`, because the
    // word follows commitment — while the progress slot collapses to an
    // em-dash, there being no committed delivery to roll up.
    const { container } = render(
      <LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+%/);
    expect(screen.getByText('4 ideas')).toBeInTheDocument();
  });

  it('renders no SVG circle (ProgressRing replaced by inline bar in #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={55} />);
    expect(container.querySelector('circle')).toBeNull();
  });

  // ── #3148: one progress slot per lane header ────────────────────────────
  // The header used to state one proportion twice — an h-1.5 track drawn at
  // `pct` and the string "55%" beside it. The slot now renders a bar OR an
  // em-dash: never both, never neither, and nothing else in the header draws
  // a bar. These four cases are the state table from the issue.
  describe('the progress slot (#3148)', () => {
    // State 1 — mid-progress.
    it('mid-progress draws the bar and no percent numeral anywhere in the header', () => {
      const { container } = render(
        <LaneMeta {...BASE_PROPS} avgProgress={55} committedTaskCount={4} />,
      );
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      // The numeral is gone from the *visible* row — not merely restyled.
      expect(screen.queryByText('55%')).not.toBeInTheDocument();
      expect(container.textContent).not.toMatch(/\d+%/);
      // Exactly one bar in the header (D4).
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    });

    it('mid-progress relocates the percentage to the accessible name (D2)', () => {
      render(<LaneMeta {...BASE_PROPS} avgProgress={55} committedTaskCount={4} />);
      // A *string* `name` here is a full-string match — Testing Library differs
      // from Playwright, whose `name` is a substring and needs `exact: true`.
      // Either way the assertion must pin the whole label, or it would bind to
      // a longer one and pass on a header that never carried the number.
      expect(
        screen.getByRole('progressbar', { name: 'Phase progress: 55% complete' }),
      ).toBeInTheDocument();
    });

    it('mid-progress puts the slot on the keyboard path so the tooltip has a route (D2)', async () => {
      render(<LaneMeta {...BASE_PROPS} avgProgress={55} taskCount={8} committedTaskCount={4} />);
      const slot = screen.getByRole('progressbar');
      expect(slot).toHaveAttribute('tabindex', '0');
      // Focus — not hover — is the channel a coarse pointer and a keyboard user
      // share. The percentage must arrive through it.
      fireEvent.focus(slot);
      expect(
        await screen.findByText('55% complete · 4 of 8 items committed'),
      ).toBeInTheDocument();
    });

    // State 2 — complete. 97% and 100% must not be four pixels apart.
    it('complete is told by form: a detached ring, still with no numeral (D3)', () => {
      const { container } = render(
        <LaneMeta {...BASE_PROPS} avgProgress={100} committedTaskCount={4} />,
      );
      const track = screen.getByRole('progressbar');
      expect(track).toHaveAttribute('aria-valuenow', '100');
      // `outline`, not `ring`: the focus ring is a `ring-*` (box-shadow), so a
      // completion `ring-1` would be replaced by `focus:ring-2` and the state
      // would disappear exactly when a keyboard user inspected it.
      expect(track.className).toContain('outline-1');
      expect(track.className).toContain('outline-brand-primary');
      expect(track.className).toContain('outline-offset-[1.5px]');
      expect(track.className).not.toContain('ring-1');
      expect(container.querySelector<HTMLElement>('[role="progressbar"] > div')?.style.width).toBe(
        '100%',
      );
      expect(container.textContent).not.toMatch(/100%/);
    });

    it('short of complete carries no outline — the hairline is the whole distinction (D3)', () => {
      render(<LaneMeta {...BASE_PROPS} avgProgress={97} committedTaskCount={4} />);
      expect(screen.getByRole('progressbar').className).not.toContain('outline-1');
    });

    // The completion mark must survive focus. A `ring-1` would not: Tailwind's
    // ring is a box-shadow and `focus:ring-2` overrides it, so a focused 100%
    // bar and a focused 97% bar would be pixel-identical.
    it('the completion mark and the focus ring occupy different channels', () => {
      render(<LaneMeta {...BASE_PROPS} avgProgress={100} committedTaskCount={4} />);
      const cls = screen.getByRole('progressbar').className;
      expect(cls).toContain('outline-1');
      expect(cls).toContain('focus:ring-2');
      // The two must not both be `ring-*`, or focus erases completion.
      expect(cls).not.toMatch(/(^|\s)ring-1(\s|$)/);
    });

    // State 3 — uncommitted. "Not applicable" is a different claim from
    // "indeterminate", so there is no progressbar element to make it with.
    it('uncommitted renders NO progressbar element at all', () => {
      const { container } = render(
        <LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />,
      );
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    });

    it('uncommitted carries the "not applicable" claim as the slot\'s accessible name', () => {
      const { container } = render(
        <LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />,
      );
      // Named via role+aria-label, NOT via an sr-only child: a bare focusable
      // span is role `generic`, which does not support name-from-content, so
      // descendant text would leave this tab stop announcing as blank.
      expect(
        screen.getByRole('img', { name: NO_PROGRESS }),
      ).toBeInTheDocument();
      // The glyph itself names nothing, so it stays out of the a11y tree.
      expect(container.querySelector('[aria-hidden="true"].tppm-mono')?.textContent).toBe('—');
    });

    it('the em-dash slot is focusable and explains itself on focus', async () => {
      render(
        <LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />,
      );
      const slot = screen.getByRole('img', { name: NO_PROGRESS });
      expect(slot).toHaveAttribute('tabindex', '0');
      fireEvent.focus(slot);
      expect(
        await screen.findByText('No committed work yet — 4 ideas'),
      ).toBeInTheDocument();
    });

    it('an uncommitted lane trades the phase accent for a neutral rail', () => {
      const { container } = render(
        <LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />,
      );
      const rail = container.querySelector<HTMLElement>('.w-\\[3px\\]');
      expect(rail?.className).toContain('bg-neutral-text-disabled');
      expect(rail?.style.background).toBe('');
    });

    it('a committed lane keeps the phase accent rail', () => {
      const { container } = render(
        <LaneMeta {...BASE_PROPS} committedTaskCount={4} railColor="#3E8C6D" />,
      );
      const rail = container.querySelector<HTMLElement>('.w-\\[3px\\]');
      expect(rail?.className).not.toContain('bg-neutral-text-disabled');
      // Assert the accent that was actually passed, not merely "something" —
      // `not.toBe('')` is satisfied by any background at all and would not
      // notice the neutral branch leaking into the committed one.
      expect(rail?.style.background).toBe('rgb(62, 140, 109)');
    });

    // Omitting the prop must mean zero. The old docblock promised a fallback to
    // `taskCount`, which answers "does this lane hold cards?" — a different
    // question from the one the slot asks.
    it('omitting committedTaskCount means zero, not taskCount', () => {
      render(<LaneMeta phaseId="p" phaseName="Ideas" avgProgress={0} taskCount={6} railColor="#3E8C6D" />);
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    // State 4 — showCost. One bar per header; spend stays in numerals.
    it('showCost adds numerals under a dashed rule and no second bar (D4)', () => {
      const { container } = render(
        <LaneMeta
          {...BASE_PROPS}
          committedTaskCount={4}
          showCost
          phaseBudgetAtCompletion={180_000}
          phaseActualCost={126_000}
        />,
      );
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
      expect(screen.getByText('$126K')).toBeInTheDocument();
      expect(screen.getByText('$180K')).toBeInTheDocument();
      const costRow = screen.getByLabelText('Phase budget: $126K of $180K');
      expect(costRow.className).toContain('border-dashed');
      expect(costRow.className).toContain('border-t');
    });

    it('showCost on an uncommitted lane still draws no bar', () => {
      const { container } = render(
        <LaneMeta
          {...BASE_PROPS}
          committedTaskCount={0}
          showCost
          phaseBudgetAtCompletion={180_000}
          phaseActualCost={126_000}
        />,
      );
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
      expect(screen.getByRole('img', { name: NO_PROGRESS })).toBeInTheDocument();
    });

    // Two em-dashes on one header: the progress slot and the cost row's "no
    // actuals" placeholder. They are different facts wearing the same glyph, so
    // a `getByText('—')` here throws on multiple matches — the accessible name
    // is what tells them apart, and is what these assertions must key on.
    it('the progress em-dash stays distinguishable from the cost em-dash', () => {
      const { container } = render(
        <LaneMeta
          {...BASE_PROPS}
          committedTaskCount={0}
          showCost
          phaseBudgetAtCompletion={180_000}
          phaseActualCost={null}
        />,
      );
      expect(screen.getAllByText('—')).toHaveLength(2);
      expect(screen.getByRole('img', { name: NO_PROGRESS })).toBeInTheDocument();
      expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    });
  });

  // ── The count word switches with the state ──────────────────────────────
  // The header's one chance to name what kind of work it holds. `items` is the
  // outline's governed neutral noun; `ideas` is a claim about commitment, not
  // about row type, which is why only the first comes from `rowVocabulary`.
  describe('the count noun (#3148)', () => {
    it('a committed lane counts items, never tasks', () => {
      render(<LaneMeta {...BASE_PROPS} taskCount={8} committedTaskCount={4} />);
      expect(screen.getByText('8 items')).toBeInTheDocument();
      expect(screen.queryByText('8 tasks')).not.toBeInTheDocument();
    });

    it('an uncommitted lane counts ideas, never tasks or items', () => {
      render(<LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />);
      expect(screen.getByText('4 ideas')).toBeInTheDocument();
      expect(screen.queryByText('4 tasks')).not.toBeInTheDocument();
      expect(screen.queryByText('4 items')).not.toBeInTheDocument();
    });

    it('the noun follows commitment, not card count — same total, both words', () => {
      // The pair is the whole point: one fixture differing only in
      // `committedTaskCount` must produce two different nouns, which no
      // single-state assertion can show.
      const { unmount } = render(
        <LaneMeta {...BASE_PROPS} taskCount={6} committedTaskCount={2} />,
      );
      expect(screen.getByText('6 items')).toBeInTheDocument();
      unmount();
      render(<LaneMeta {...BASE_PROPS} taskCount={6} committedTaskCount={0} avgProgress={0} />);
      expect(screen.getByText('6 ideas')).toBeInTheDocument();
    });

    it('takes the committed noun from rowVocabulary, not a local literal', () => {
      // If someone re-words `countRows`, this header must move with it rather
      // than keeping a copy that silently disagrees with the outline.
      render(<LaneMeta {...BASE_PROPS} taskCount={3} committedTaskCount={1} />);
      expect(screen.getByText(countRows(3))).toBeInTheDocument();
    });
  });

  // ── The one proportion, stated through four carriers ────────────────────
  // #3148's whole thesis is that a proportion stated twice can drift. The
  // percentage now travels through four channels at once — fill width,
  // aria-valuenow, the accessible name, and the tooltip — so the property
  // worth pinning is that they AGREE, not that each is individually right.
  // Asserting them in four separate tests with four different fixtures (as the
  // suite did before) cannot see a disagreement at a single pct.
  describe('the carriers of the percentage agree (#3148)', () => {
    for (const pct of [0, 37, 55, 97, 100]) {
      it(`all four channels read ${pct}%`, async () => {
        const { container, unmount } = render(
          <LaneMeta {...BASE_PROPS} avgProgress={pct} taskCount={8} committedTaskCount={4} />,
        );
        const bar = screen.getByRole('progressbar');
        expect(bar).toHaveAttribute('aria-valuenow', String(pct));
        expect(bar).toHaveAttribute('aria-label', `Phase progress: ${pct}% complete`);
        expect(
          container.querySelector<HTMLElement>('[role="progressbar"] > div')?.style.width,
        ).toBe(`${pct}%`);
        fireEvent.focus(bar);
        expect(
          await screen.findByText(`${pct}% complete · 4 of 8 items committed`),
        ).toBeInTheDocument();
        // …and the visible row states it zero times.
        expect(container.textContent).not.toMatch(/\d+%/);
        unmount();
      });
    }
  });

  // ── Tooltip copy branches ───────────────────────────────────────────────
  describe('the slot tooltip (#3148)', () => {
    it('an empty phase says so rather than counting zero ideas', async () => {
      // The `taskCount === 0` branch produces its own string; "0 uncommitted
      // tasks" would be a strange way to say "there is nothing here".
      render(<LaneMeta {...BASE_PROPS} taskCount={0} committedTaskCount={0} avgProgress={0} />);
      fireEvent.focus(screen.getByRole('img', { name: NO_PROGRESS }));
      expect(await screen.findByText(ROW_VOCABULARY.create.phaseHasNoRows)).toBeInTheDocument();
    });

    it('uses the singular when one task is uncommitted', async () => {
      render(<LaneMeta {...BASE_PROPS} taskCount={1} committedTaskCount={0} avgProgress={0} />);
      fireEvent.focus(screen.getByRole('img', { name: NO_PROGRESS }));
      expect(
        await screen.findByText('No committed work yet — 1 idea'),
      ).toBeInTheDocument();
    });

    it('uses the singular in the committed tooltip too', async () => {
      render(<LaneMeta {...BASE_PROPS} taskCount={1} committedTaskCount={1} avgProgress={40} />);
      fireEvent.focus(screen.getByRole('progressbar'));
      expect(
        await screen.findByText('40% complete · 1 of 1 item committed'),
      ).toBeInTheDocument();
    });
  });

  // ── Workshop variant × the slot ─────────────────────────────────────────
  // Every other workshop test inherits BASE_PROPS' committed count, so this is
  // the only place the two features meet.
  describe('workshop mode with an uncommitted lane (#3148)', () => {
    it('flips the rail to neutral but keeps the phase tint on the lane body', () => {
      const { container } = render(
        <LaneMeta
          {...BASE_PROPS}
          workshop
          taskCount={3}
          committedTaskCount={0}
          avgProgress={0}
        />,
      );
      // The 3px edge is the "is there anything measurable here" signal and goes
      // neutral. The 5% body wash is phase IDENTITY — which lane am I editing —
      // and is deliberately NOT tied to commitment, or reordering phases in
      // workshop mode would lose the color that tells them apart.
      const rail = container.querySelector<HTMLElement>('.w-\\[3px\\]');
      expect(rail?.className).toContain('bg-neutral-text-disabled');
      expect((container.firstChild as HTMLElement).style.background).toContain('#3E8C6D');
      // The slot still resolves, and the editable name is still reachable.
      expect(screen.getByRole('img', { name: NO_PROGRESS })).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /Phase name: Engineering/ })).toBeInTheDocument();
    });
  });

  it('renders workshop variant with contentEditable name', () => {
    render(<LaneMeta {...BASE_PROPS} workshop />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    expect(textbox).toBeInTheDocument();
    expect(textbox).toHaveAttribute('contenteditable', 'true');
  });

  it('renders drag handle in workshop mode', () => {
    render(<LaneMeta {...BASE_PROPS} workshop />);
    expect(screen.getByTitle('Drag to reorder phase')).toBeInTheDocument();
  });

  // #2201: the handle must be a real, labeled, focusable button so keyboard/SR
  // users can discover and operate phase reordering. It was previously an
  // aria-hidden pointer-only span while the sortable role/tabindex sat on the
  // whole lane wrapper.
  it('drag handle is a labeled button carrying the sortable attributes', () => {
    render(
      <LaneMeta
        {...BASE_PROPS}
        workshop
        dragHandleAttributes={{ role: 'button', tabIndex: 0, 'aria-roledescription': 'sortable' }}
      />,
    );
    const handle = screen.getByRole('button', { name: 'Reorder phase: Engineering' });
    expect(handle.tagName).toBe('BUTTON');
    expect(handle).not.toHaveAttribute('aria-hidden');
    expect(handle).toHaveAttribute('aria-roledescription', 'sortable');
  });

  it('does not render drag handle in normal mode', () => {
    render(<LaneMeta {...BASE_PROPS} />);
    expect(screen.queryByTitle('Drag to reorder phase')).not.toBeInTheDocument();
  });

  it('renders collapseToggle when provided', () => {
    render(
      <LaneMeta
        {...BASE_PROPS}
        collapseToggle={<button>▾</button>}
      />,
    );
    expect(screen.getByRole('button', { name: '▾' })).toBeInTheDocument();
  });

  it('calls onPhaseRename when the editable name blurs with a new value', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = '  Discovery  ';
    fireEvent.blur(textbox);
    expect(onPhaseRename).toHaveBeenCalledWith('Discovery');
  });

  it('does not call onPhaseRename when the name is unchanged after blur', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    fireEvent.blur(textbox);
    expect(onPhaseRename).not.toHaveBeenCalled();
  });

  it('reverts the editable name to the original on blur when emptied', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = '   ';
    fireEvent.blur(textbox);
    expect(onPhaseRename).not.toHaveBeenCalled();
    expect(textbox.textContent).toBe('Engineering');
  });

  it('commits the edit on Enter key', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = 'Build';
    fireEvent.keyDown(textbox, { key: 'Enter' });
    // Enter triggers blur, which fires the onBlur handler with the new value.
    fireEvent.blur(textbox);
    expect(onPhaseRename).toHaveBeenCalledWith('Build');
  });

  it('reverts the edit on Escape key', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = 'AbandonedEdit';
    fireEvent.keyDown(textbox, { key: 'Escape' });
    expect(textbox.textContent).toBe('Engineering');
    fireEvent.blur(textbox);
    expect(onPhaseRename).not.toHaveBeenCalled();
  });

  it('ignores blur when no onPhaseRename callback is provided', () => {
    render(<LaneMeta {...BASE_PROPS} workshop />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = 'Whatever';
    expect(() => fireEvent.blur(textbox)).not.toThrow();
  });

  describe('budget display', () => {
    it('formats large budgets in millions ($1.5M)', () => {
      render(
        <LaneMeta
          {...BASE_PROPS}
          showCost
          phaseBudgetAtCompletion={1_500_000}
          phaseActualCost={null}
        />,
      );
      expect(screen.getByText(/\$1\.5M/)).toBeInTheDocument();
    });

    it('formats mid-size budgets in thousands ($45K)', () => {
      render(
        <LaneMeta
          {...BASE_PROPS}
          showCost
          phaseBudgetAtCompletion={45_000}
          phaseActualCost={null}
        />,
      );
      expect(screen.getByText(/\$45K/)).toBeInTheDocument();
    });

    it('formats small budgets in dollars ($250)', () => {
      render(
        <LaneMeta
          {...BASE_PROPS}
          showCost
          phaseBudgetAtCompletion={250}
          phaseActualCost={null}
        />,
      );
      expect(screen.getByText(/\$250/)).toBeInTheDocument();
    });
  });
});
