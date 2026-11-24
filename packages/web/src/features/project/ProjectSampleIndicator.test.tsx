import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectSampleIndicator } from './ProjectSampleIndicator';

const useProject = vi.fn();
vi.mock('@/hooks/useProject', () => ({
  useProject: () => useProject() as { data: unknown },
}));

// Read-only demo gate (ADR-1197 D3, #4049) — mocked the same way CommentComposer's
// spec mocks it, so the demo branch here is exercised by its own case below.
const demoMode = vi.hoisted(() => ({
  value: { isDemoReadOnly: false, loginHint: null, isLoading: false },
}));
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode.value }));

function renderIndicator() {
  return render(
    <MemoryRouter>
      <ProjectSampleIndicator projectId="p1" />
    </MemoryRouter>,
  );
}

describe('ProjectSampleIndicator', () => {
  afterEach(() => {
    demoMode.value = { isDemoReadOnly: false, loginHint: null, isLoading: false };
  });

  it('renders nothing for a non-sample project', () => {
    useProject.mockReturnValue({ data: { is_sample: false } });
    const { container } = renderIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the project is still loading', () => {
    useProject.mockReturnValue({ data: undefined });
    const { container } = renderIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the demo cue, program name, and a manage link for a sample project', () => {
    useProject.mockReturnValue({
      data: { is_sample: true, program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' } },
    });
    renderIndicator();
    expect(screen.getByText(/Demo project/)).toBeInTheDocument();
    expect(screen.getByText('Atlas Platform Launch')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage demo data/i })).toHaveAttribute(
      'href',
      '/programs/prog-9',
    );
  });

  it('shows the cue without a link when the project has no program', () => {
    useProject.mockReturnValue({ data: { is_sample: true, program_detail: null } });
    renderIndicator();
    expect(screen.getByText(/Demo project/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing at all in the read-only interactive demo (#4049, #4050 A1)', () => {
    // #4049 hid only the manage link here. #4050 removes the whole strip on that
    // deployment: DemoModeBar now says the mode, the provenance and the program,
    // and offers the project as a switcher — so this would be a second copy of
    // all four, in one of the five bands the issue exists to reclaim. A
    // self-hoster's own demo program still gets the strip (the cases below).
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: false };
    useProject.mockReturnValue({
      data: { is_sample: true, program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' } },
    });
    const { container } = renderIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the manage link outside the read-only demo', () => {
    demoMode.value = { isDemoReadOnly: false, loginHint: null, isLoading: false };
    useProject.mockReturnValue({
      data: { is_sample: true, program_detail: { id: 'prog-9', name: 'Atlas Platform Launch' } },
    });
    renderIndicator();
    expect(screen.getByRole('link', { name: /manage demo data/i })).toHaveAttribute(
      'href',
      '/programs/prog-9',
    );
  });
  describe('staleness notice (#3481)', () => {
    function withStale(sample_days_stale: number | null | undefined) {
      useProject.mockReturnValue({
        data: {
          is_sample: true,
          program_detail: { id: 'prog-9', name: 'Atlas Platform Launch', sample_days_stale },
        },
      });
      renderIndicator();
    }

    it('says how far out of date the dates are once the demo is 28+ days stale', () => {
      withStale(47);
      expect(screen.getByText('dates 47 days out of date')).toBeInTheDocument();
    });

    it('treats exactly 28 days as stale and 27 as fresh (threshold matches SampleDataBanner)', () => {
      withStale(28);
      expect(screen.getByText('dates 28 days out of date')).toBeInTheDocument();
    });

    it('stays silent just under the threshold', () => {
      withStale(27);
      expect(screen.queryByText(/out of date/)).not.toBeInTheDocument();
      expect(screen.getByText(/Demo project/)).toBeInTheDocument();
    });

    it('says the dates may be out of date for a null anchor (legacy sample, #3875)', () => {
      withStale(null);
      expect(screen.getByText(/dates may be out of date/)).toBeInTheDocument();
    });

    it('shows the same cue when the field is absent from the payload', () => {
      withStale(undefined);
      expect(screen.getByText(/dates may be out of date/)).toBeInTheDocument();
    });

    it('still offers the manage link next to the notice (notice here, act there)', () => {
      withStale(47);
      expect(screen.getByRole('link', { name: /manage demo data/i })).toHaveAttribute(
        'href',
        '/programs/prog-9',
      );
    });
  });
});
