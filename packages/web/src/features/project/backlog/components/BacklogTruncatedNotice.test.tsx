import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BacklogTruncatedNotice } from './BacklogTruncatedNotice';

describe('BacklogTruncatedNotice (#2344)', () => {
  it('states shown/total by rank with locale-grouped numbers and loads the next page', () => {
    const onLoadMore = vi.fn();
    render(
      <BacklogTruncatedNotice
        shown={1500}
        total={12000}
        limit={500}
        onLoadMore={onLoadMore}
        loading={false}
      />,
    );
    const notice = screen.getByRole('complementary', { name: 'Backlog truncated' });
    expect(notice).toHaveTextContent(
      `Showing the top ${(1500).toLocaleString()} of ${(12000).toLocaleString()} stories by rank`,
    );
    expect(notice).not.toHaveAttribute('role', 'status');
    fireEvent.click(screen.getByRole('button', { name: 'Load next 500' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers only the remainder on the last page', () => {
    render(
      <BacklogTruncatedNotice
        shown={500}
        total={620}
        limit={500}
        onLoadMore={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Load next 120' })).toBeInTheDocument();
  });

  it('disables the control while a page loads', () => {
    render(
      <BacklogTruncatedNotice shown={500} total={620} limit={500} onLoadMore={vi.fn()} loading />,
    );
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
  });

  it('renders nothing when the server sent no limit, or everything is loaded', () => {
    const { container, rerender } = render(
      <BacklogTruncatedNotice
        shown={0}
        total={10}
        limit={0}
        onLoadMore={vi.fn()}
        loading={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <BacklogTruncatedNotice
        shown={10}
        total={10}
        limit={500}
        onLoadMore={vi.fn()}
        loading={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
