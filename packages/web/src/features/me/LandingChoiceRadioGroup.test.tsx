/**
 * Unit tests for LandingChoiceRadioGroup (ADR-0129, #1181).
 *
 * Covers:
 *   - Rendering concrete options + optional autoOption.
 *   - Roving tabindex: only the focused (or initially selected) option is
 *     tabIndex=0; all others are -1 (rule 167 / WCAG 2.1.1).
 *   - Arrow-key focus movement: ArrowDown/Right/Up/Left move DOM focus to the
 *     adjacent enabled option WITHOUT committing (onChange not called).
 *   - Wrapping: ArrowDown on the last option moves to the first.
 *   - Disabled options are skipped during arrow navigation.
 *   - Clicking an option calls onChange (commit on click, not on arrow).
 *   - An `enterprise: true` option (Portfolio) is OMITTED entirely in the
 *     community edition — never rendered disabled/badged (rule 231(c), #4477).
 *   - The same option renders normally (enabled, no badge) in the enterprise
 *     edition.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LandingChoiceRadioGroup, type LandingChoiceOption } from './LandingChoiceRadioGroup';

let mockEdition: 'community' | 'enterprise' = 'community';
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: mockEdition, isLoading: false }),
}));

// Default to community for every test unless a test opts into enterprise.
beforeEach(() => {
  mockEdition = 'community';
});

const OPTIONS: LandingChoiceOption[] = [
  { value: 'my_work', label: 'My Work', description: 'Your cross-project task list.' },
  {
    value: 'project_overview',
    label: "A project's Overview",
    description: 'Open straight into your most recent project.',
  },
  {
    value: 'portfolio',
    label: 'Portfolio',
    description: 'The cross-program portfolio dashboard.',
    enterprise: true,
  },
];

function renderGroup(
  value: Parameters<typeof LandingChoiceRadioGroup>[0]['value'] = 'my_work',
  onChange = vi.fn(),
  extra?: Partial<Parameters<typeof LandingChoiceRadioGroup>[0]>,
) {
  return render(
    <LandingChoiceRadioGroup
      label="Default landing screen"
      options={OPTIONS}
      value={value}
      onChange={onChange}
      {...extra}
    />,
  );
}

describe('LandingChoiceRadioGroup — rendering', () => {
  it('renders the non-enterprise options as radio buttons, omitting Portfolio in community', () => {
    renderGroup();
    expect(screen.getByRole('radio', { name: /My Work/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /A project's Overview/i })).toBeInTheDocument();
    // Portfolio has no reachable control in community — omitted entirely, not
    // rendered disabled/badged (rule 231(c), #4477).
    expect(screen.queryByRole('radio', { name: /Portfolio/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Enterprise')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('marks the selected option aria-checked=true and others false', () => {
    renderGroup('project_overview');
    expect(screen.getByRole('radio', { name: /A project's Overview/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('renders Portfolio enabled with no badge in the enterprise edition', () => {
    mockEdition = 'enterprise';
    renderGroup();
    const portfolio = screen.getByRole('radio', { name: /Portfolio/i });
    expect(portfolio).not.toBeDisabled();
    expect(screen.queryByText('Enterprise')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('renders the autoOption inside the same radiogroup when provided', () => {
    mockEdition = 'enterprise';
    renderGroup('my_work', vi.fn(), {
      autoOption: {
        checked: false,
        helperText: 'Picks the best screen.',
        onClick: vi.fn(),
      },
    });
    expect(screen.getByRole('radio', { name: /Auto \(recommended\)/i })).toBeInTheDocument();
    // All four radios are in a single radiogroup.
    const group = screen.getByRole('radiogroup');
    const radios = group.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(4);
  });
});

describe('LandingChoiceRadioGroup — roving tabindex (rule 167 / WCAG 2.1.1)', () => {
  it('the initially selected option is tabIndex=0; others are -1', () => {
    renderGroup('project_overview');
    expect(screen.getByRole('radio', { name: /A project's Overview/i })).toHaveAttribute(
      'tabIndex',
      '0',
    );
    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute('tabIndex', '-1');
  });

  it('when no option is selected the first option is tabIndex=0', () => {
    // Pass a value that matches no option so selectedIdx === -1.
    // We use 'auto' without an autoOption, so focusIdx defaults to 0.
    renderGroup('auto' as Parameters<typeof LandingChoiceRadioGroup>[0]['value']);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveAttribute('tabIndex', '0');
    expect(radios[1]).toHaveAttribute('tabIndex', '-1');
  });

  it('ArrowDown moves focus to next option WITHOUT calling onChange', () => {
    const onChange = vi.fn();
    renderGroup('my_work', onChange);
    const group = screen.getByRole('radiogroup');
    const firstRadio = screen.getByRole('radio', { name: /My Work/i });
    firstRadio.focus();

    fireEvent.keyDown(group, { key: 'ArrowDown' });

    // Focus has moved to the next non-disabled option (project_overview).
    expect(screen.getByRole('radio', { name: /A project's Overview/i })).toHaveAttribute(
      'tabIndex',
      '0',
    );
    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute('tabIndex', '-1');
    // onChange must NOT have been called — arrow keys move focus only.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowRight also moves focus forward', () => {
    const onChange = vi.fn();
    renderGroup('my_work', onChange);
    const group = screen.getByRole('radiogroup');

    fireEvent.keyDown(group, { key: 'ArrowRight' });

    expect(screen.getByRole('radio', { name: /A project's Overview/i })).toHaveAttribute(
      'tabIndex',
      '0',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowUp moves focus to the previous option', () => {
    const onChange = vi.fn();
    renderGroup('project_overview', onChange);
    const group = screen.getByRole('radiogroup');

    fireEvent.keyDown(group, { key: 'ArrowUp' });

    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute('tabIndex', '0');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowLeft also moves focus backward', () => {
    const onChange = vi.fn();
    renderGroup('project_overview', onChange);
    const group = screen.getByRole('radiogroup');

    fireEvent.keyDown(group, { key: 'ArrowLeft' });

    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute('tabIndex', '0');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ArrowDown wraps from last to first (Portfolio omitted in community, so it is never a stop)', () => {
    const onChange = vi.fn();
    // Start with project_overview selected (index 1, the last rendered option
    // in community since Portfolio is omitted entirely); pressing Down wraps
    // straight to My Work (index 0).
    renderGroup('project_overview', onChange);
    const group = screen.getByRole('radiogroup');

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute('tabIndex', '0');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a disabled autoOption is still skipped during arrow nav (per-item disable survives the Portfolio fix)', () => {
    const onChange = vi.fn();
    const onAutoClick = vi.fn();
    // project_overview is the last concrete option in community (index 1);
    // ArrowDown would normally land on Auto (index 2), but it is individually
    // disabled here, so it must be skipped, wrapping to My Work (index 0).
    renderGroup('project_overview', onChange, {
      autoOption: {
        checked: false,
        helperText: 'Picks the best screen.',
        onClick: onAutoClick,
        disabled: true,
      },
    });
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /My Work/i })).toHaveAttribute('tabIndex', '0');
    expect(onChange).not.toHaveBeenCalled();
    expect(onAutoClick).not.toHaveBeenCalled();
  });

  it('clicking an option calls onChange (commit on activation, not arrow)', () => {
    const onChange = vi.fn();
    renderGroup('my_work', onChange);
    fireEvent.click(screen.getByRole('radio', { name: /A project's Overview/i }));
    expect(onChange).toHaveBeenCalledWith('project_overview');
  });

  it('ArrowDown into autoOption region moves focus there without committing', () => {
    const onAutoClick = vi.fn();
    const onChange = vi.fn();
    renderGroup('project_overview', onChange, {
      autoOption: {
        checked: false,
        helperText: 'Picks the best screen.',
        onClick: onAutoClick,
      },
    });
    const group = screen.getByRole('radiogroup');

    // Start at project_overview (index 1, the last concrete option in community
    // since Portfolio is omitted entirely); pressing Down moves straight to Auto
    // (index 2).
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: /Auto \(recommended\)/i })).toHaveAttribute(
      'tabIndex',
      '0',
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(onAutoClick).not.toHaveBeenCalled();
  });
});
