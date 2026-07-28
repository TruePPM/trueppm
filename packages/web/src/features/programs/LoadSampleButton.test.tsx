import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SampleInfo } from '@/hooks/useProgramSeedIo';
import { LoadSampleButton } from './LoadSampleButton';

const loadMutate = vi.fn();
let samplesState: { data: SampleInfo[] | undefined } = { data: undefined };

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useSamples: () => samplesState,
  useLoadSampleProgram: () => ({ mutate: loadMutate, isPending: false }),
}));

function sample(overrides: Partial<SampleInfo> = {}): SampleInfo {
  return {
    key: 'atlas-platform-launch',
    title: 'Atlas Platform Launch',
    description: 'Hybrid-large launch program.',
    filename: 'atlas-platform-launch.json',
    available: true,
    size_bytes: 79544,
    sha256: 'a'.repeat(64),
    schema_version: '2.0',
    project_count: 3,
    task_count: 88,
    resource_count: 15,
    download_url: '/api/v1/programs/samples/atlas-platform-launch/download/',
    ...overrides,
  };
}

const TWO_SAMPLES = [
  sample(),
  sample({
    key: 'aurora-mobile-app',
    title: 'Aurora Mobile App',
    description: 'Agile-only.',
    project_count: 1,
    task_count: 41,
  }),
];

async function openPicker() {
  render(
    <MemoryRouter>
      <LoadSampleButton />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: /Load demo data/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  samplesState = { data: TWO_SAMPLES };
});

describe('LoadSampleButton picker', () => {
  it('answers "how much is this about to write?" in the row itself', async () => {
    await openPicker();

    expect(screen.getByText('3 projects · 88 tasks')).toBeInTheDocument();
    expect(screen.getByText('1 project · 41 tasks')).toBeInTheDocument();
  });

  it('falls back to the description when the server could not summarize', async () => {
    // Two samples, because a single bundled sample loads directly instead of
    // opening the picker.
    samplesState = {
      data: [sample({ project_count: null, task_count: null }), TWO_SAMPLES[1]],
    };
    await openPicker();

    expect(screen.getByText('Hybrid-large launch program.')).toBeInTheDocument();
  });

  it('never renders "undefined" for a payload missing the count keys', async () => {
    // A cached pre-#2490 catalog response omits the keys entirely.
    const legacy = sample();
    delete (legacy as Partial<SampleInfo>).project_count;
    delete (legacy as Partial<SampleInfo>).task_count;
    samplesState = { data: [legacy, TWO_SAMPLES[1]] };
    await openPicker();

    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('offers the audit path without competing with Load', async () => {
    // Load is the reason this menu exists and must stay the only filled control;
    // "Inspect files" is a text link in the footer, for the minority looking for it.
    await openPicker();

    const inspect = screen.getByRole('menuitem', { name: /Inspect files/i });
    expect(inspect).toHaveAttribute('href', '/settings/demo-data');
    expect(inspect.className).not.toMatch(/bg-brand-primary/);
  });

  it('opens the listing in a new tab so the picker survives the detour', async () => {
    await openPicker();

    const inspect = screen.getByRole('menuitem', { name: /Inspect files/i });
    expect(inspect).toHaveAttribute('target', '_blank');
    expect(inspect).toHaveAttribute('rel', 'noopener');
  });

  it('still loads a sample from the picker after the footer row exists', async () => {
    await openPicker();
    await userEvent.click(screen.getByRole('menuitem', { name: /Atlas Platform Launch/i }));

    expect(loadMutate).toHaveBeenCalledWith('atlas-platform-launch', expect.anything());
  });
});
