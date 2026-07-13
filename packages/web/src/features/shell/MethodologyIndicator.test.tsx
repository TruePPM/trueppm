import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { useShellStore } from '@/stores/shellStore';
import { MethodologyIndicator } from './MethodologyIndicator';

// Default: has a project ID. Off-project tests override via mockReturnValue.
vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: vi.fn(() => 'proj-1'),
}));

// Default: HYBRID methodology. MethodologyIndicator reads the SERVER-RESOLVED
// `effective_methodology` (ADR-0107, web-rule 196), so seed both.
vi.mock('@/hooks/useProject', () => ({
  useProject: vi.fn(() => ({
    data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
    isLoading: false,
    error: null,
  })),
}));

import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
const mockUseProjectId = useProjectId as ReturnType<typeof vi.fn>;
const mockUseProject = useProject as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUseProjectId.mockReturnValue('proj-1');
  mockUseProject.mockReturnValue({
    data: { id: 'proj-1', methodology: 'HYBRID', effective_methodology: 'HYBRID' },
    isLoading: false,
    error: null,
  });
  // Collapsed by default here — this is the state the badge renders in (the
  // 768–1023px auto-collapsed band, and any manually-collapsed rail width).
  useShellStore.setState({ sidebarCollapsed: true, sidebarUserControlled: false });
});

describe('MethodologyIndicator (issue #1907, restoring #1469 after #1680)', () => {
  // Compact-badge signal must survive while the rail is collapsed — the band
  // #1680's rail subtitle cannot cover. Each methodology maps to a 2-letter glyph
  // whose accessible name is the full methodology (WCAG 1.4.1 — never letter- or
  // color-only).
  const cases = [
    { methodology: 'HYBRID', code: 'HY', name: 'Hybrid workspace' },
    { methodology: 'WATERFALL', code: 'WF', name: 'Waterfall workspace' },
    { methodology: 'AGILE', code: 'AG', name: 'Agile workspace' },
  ] as const;

  it.each(cases)(
    'renders the $code badge with a full accessible name for $methodology while the rail is collapsed',
    ({ methodology, code, name }) => {
      mockUseProject.mockReturnValue({
        data: { id: 'proj-1', methodology, effective_methodology: methodology },
        isLoading: false,
        error: null,
      });
      renderWithRouter(<MethodologyIndicator />, { initialEntries: ['/projects/proj-1/board'] });

      const badge = screen.getByRole('img', { name });
      expect(badge).toHaveTextContent(code);
    },
  );

  it('reads the server-resolved preset (effective_methodology, ADR-0107 / web-rule 196)', () => {
    // Raw per-project AGILE but a server-resolved WATERFALL workspace lock — the
    // resolved value must win, matching the rail subtitle it must never contradict.
    mockUseProject.mockReturnValue({
      data: { id: 'proj-1', methodology: 'AGILE', effective_methodology: 'WATERFALL' },
      isLoading: false,
      error: null,
    });
    renderWithRouter(<MethodologyIndicator />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('img', { name: 'Waterfall workspace' })).toHaveTextContent('WF');
  });

  it('falls back to HYBRID before the project loads', () => {
    mockUseProject.mockReturnValue({ data: undefined, isLoading: true, error: null });
    renderWithRouter(<MethodologyIndicator />, { initialEntries: ['/projects/proj-1/board'] });
    expect(screen.getByRole('img', { name: 'Hybrid workspace' })).toHaveTextContent('HY');
  });

  it('renders null off a project route', () => {
    mockUseProjectId.mockReturnValue(undefined);
    const { container } = renderWithRouter(<MethodologyIndicator />);
    expect(container.firstChild).toBeNull();
  });

  // The no-duplication contract (#1907 AC): once the rail is expanded, the
  // "This project" card subtitle (`Sidebar.tsx`) carries the signal instead, so
  // this bar badge must render nothing — never both at once.
  it('renders null while the rail is expanded (avoids duplicating the rail subtitle)', () => {
    useShellStore.setState({ sidebarCollapsed: false, sidebarUserControlled: false });
    const { container } = renderWithRouter(<MethodologyIndicator />, {
      initialEntries: ['/projects/proj-1/board'],
    });
    expect(container.firstChild).toBeNull();
  });
});
