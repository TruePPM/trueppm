import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SampleInfo, SampleCatalogStatus } from '@/hooks/useProgramSeedIo';
import { DemoDataPage, formatBytes } from './DemoDataPage';

// Isolate the listing from the settings shell chrome.
vi.mock('../SettingsShell', () => ({
  SettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsPageTitle: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: { name: 'TrueScope' }, isLoading: false }),
}));

const retry = vi.fn();
const loadMutate = vi.fn();
let catalogState: { samples: SampleInfo[]; status: SampleCatalogStatus; retry: () => void } = {
  samples: [],
  status: 'ready',
  retry,
};

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useSampleCatalog: () => catalogState,
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
    sha256: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    schema_version: '2.0',
    project_count: 3,
    task_count: 88,
    resource_count: 15,
    download_url: '/api/v1/programs/samples/atlas-platform-launch/download/',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DemoDataPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  catalogState = { samples: [sample()], status: 'ready', retry };
});

describe('formatBytes', () => {
  it('renders KB with one decimal and tolerates a missing size', () => {
    expect(formatBytes(79544)).toBe('77.7 KB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(null)).toBeNull();
  });
});

describe('DemoDataPage', () => {
  it('lists each sample with its scale, size and digest', () => {
    renderPage();

    expect(screen.getByText('Atlas Platform Launch')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText('77.7 KB')).toBeInTheDocument();
    expect(screen.getByText(/sha256 a1b2c3d4…/)).toBeInTheDocument();
    expect(screen.getByText('schema 2.0')).toBeInTheDocument();
  });

  it('links the download to the server-supplied URL rather than assembling one', () => {
    // The server is the only thing that decides what a key maps to; a client
    // that built this href from `key` would be a second, drifting router.
    renderPage();

    const link = screen.getByRole('link', { name: 'Download' });
    expect(link).toHaveAttribute(
      'href',
      '/api/v1/programs/samples/atlas-platform-launch/download/',
    );
    expect(link).toHaveAttribute('download', 'atlas-platform-launch.json');
  });

  it('copies the full 64-character digest, not the truncated display form', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: /Copy full SHA-256/i }));

    expect(writeText).toHaveBeenCalledWith(
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    );
    // No prefix, no whitespace — it has to pipe straight into a comparison.
    expect(String(writeText.mock.calls[0]?.[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps an unsummarizable fixture downloadable', () => {
    // State 3. "We couldn't parse it" must never become "you can't have it" —
    // the bytes are the deliverable, the counts are the convenience.
    catalogState = {
      samples: [
        sample({
          project_count: null,
          task_count: null,
          resource_count: null,
          schema_version: null,
        }),
      ],
      status: 'ready',
      retry,
    };
    renderPage();

    expect(screen.getByText('counts unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/v1/programs/samples/atlas-platform-launch/download/',
    );
  });

  it('disables both actions when the fixture is missing from disk', () => {
    catalogState = {
      samples: [sample({ available: false, sha256: null, size_bytes: null })],
      status: 'ready',
      retry,
    };
    renderPage();

    expect(screen.getByText('file missing')).toBeInTheDocument();
    // A disabled button, not a hrefless anchor — an anchor without href has no
    // link role and is never announced as an action at all.
    expect(screen.queryByRole('link', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Load' })).toBeDisabled();
  });

  it('treats a response missing the count keys as unsummarized, not as "undefined"', () => {
    // An older cached catalog payload (pre-#2490) omits the keys entirely.
    const legacy = sample();
    delete (legacy as Partial<SampleInfo>).project_count;
    delete (legacy as Partial<SampleInfo>).task_count;
    catalogState = { samples: [legacy], status: 'ready', retry };
    renderPage();

    expect(screen.getByText('counts unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it('offers a working retry when the catalog request fails', async () => {
    catalogState = { samples: [], status: 'error', retry };
    renderPage();

    expect(screen.getByText("Couldn't load the sample list")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('renders an honest empty state when no fixtures are bundled', () => {
    catalogState = { samples: [], status: 'ready', retry };
    renderPage();

    expect(screen.getByText('No sample programs are bundled')).toBeInTheDocument();
  });

  it('reserves exactly four skeleton rows while loading so counts land without a jump', () => {
    catalogState = { samples: [], status: 'loading', retry };
    const { container } = renderPage();

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('Atlas Platform Launch')).not.toBeInTheDocument();
  });

  it('names the procedural-seed asymmetry in the product, not only the docs', () => {
    // A self-hoster who audits four files and believes he has audited all the
    // demo data has been misled by omission.
    renderPage();

    expect(screen.getByText(/Two demo programs are not files/)).toBeInTheDocument();
    expect(screen.getByText(/seed_demo_project/)).toBeInTheDocument();
  });

  it('states what the hash proves, and does not overclaim provenance', () => {
    renderPage();
    expect(screen.getByText(/not who wrote it/)).toBeInTheDocument();
  });

  it('loads a sample by key', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(loadMutate).toHaveBeenCalledWith('atlas-platform-launch', expect.anything());
  });
});
