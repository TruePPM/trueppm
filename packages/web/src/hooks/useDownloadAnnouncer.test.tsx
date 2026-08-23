import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useDownloadAnnouncer } from './useDownloadAnnouncer';

const downloadCsvMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/exportCsv', () => ({ downloadCsv: downloadCsvMock }));

function Harness() {
  const { announce, download, region } = useDownloadAnnouncer();
  return (
    <div>
      <button type="button" onClick={() => download('a,b', 'x.csv', 'Rows downloaded.')}>
        Save
      </button>
      <button type="button" onClick={() => announce('Report downloaded.')}>
        Announce only
      </button>
      {region}
    </div>
  );
}

describe('useDownloadAnnouncer', () => {
  beforeEach(() => {
    downloadCsvMock.mockReset();
  });

  it('mounts the live region before any download happens', () => {
    // Load-bearing, not tidy: a live region created in the same tick as its content
    // does not reliably announce, so it must exist empty up front (rule 297).
    const { container } = render(<Harness />);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('');
  });

  it('saves the file and then announces', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(downloadCsvMock).toHaveBeenCalledWith('a,b', 'x.csv');
    expect(screen.getByText('Rows downloaded.')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not claim a download that threw', () => {
    // The announcement follows the save, so a failed blob/anchor sequence never
    // tells a screen-reader user a file arrived. Driven through renderHook rather
    // than a click: React's event delegation swallows the rethrow in jsdom, which
    // would make a `toThrow()` assertion on the click pass for the wrong reason.
    downloadCsvMock.mockImplementation(() => {
      throw new Error('blob failed');
    });
    const { result } = renderHook(() => useDownloadAnnouncer());

    expect(() => result.current.download('a,b', 'x.csv', 'Rows downloaded.')).toThrow(
      'blob failed',
    );

    const { container } = render(<div>{result.current.region}</div>);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('');
  });

  it('announces without downloading, for a caller that owns its own save', () => {
    // exportRisksToCSV derives its own local-day filename, so its callers keep the
    // helper and announce beside it.
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Announce only' }));

    expect(downloadCsvMock).not.toHaveBeenCalled();
    expect(screen.getByText('Report downloaded.')).toBeInTheDocument();
  });

  it('keeps the region polite rather than assertive', () => {
    // A download confirmation must not interrupt what the user is doing.
    const { container } = render(<Harness />);
    expect(container.querySelector('[aria-live="assertive"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).toHaveClass('sr-only');
  });
});
