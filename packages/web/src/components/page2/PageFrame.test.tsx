import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageFrame } from './PageFrame';

describe('PageFrame (rule 439)', () => {
  it('caps a contained page at 1120px with the four-step gutter', () => {
    render(
      <PageFrame width="contained" header={<h1>Overview</h1>}>
        <p>body</p>
      </PageFrame>,
    );
    const body = screen.getByTestId('page-frame-body');
    expect(body.className).toMatch(/\bpx-4\b.*\bmd:px-5\b.*\blg:px-6\b.*\b2xl:px-8\b/);
    expect(body.firstElementChild).toHaveClass('max-w-[1120px]', 'mx-auto');
    expect(screen.getByTestId('page-frame')).toHaveAttribute('data-width', 'contained');
  });

  it('runs a bleed page edge to edge with no gutter on the body', () => {
    render(
      <PageFrame width="bleed">
        <p>canvas</p>
      </PageFrame>,
    );
    const body = screen.getByTestId('page-frame-body');
    expect(body.className).not.toMatch(/px-/);
    expect(body.firstElementChild).not.toHaveClass('max-w-[1120px]');
  });

  it('renders the toolbar row when there is no override', () => {
    render(
      <PageFrame width="contained" toolbar={<button type="button">Filter</button>}>
        <p />
      </PageFrame>,
    );
    const row = screen.getByTestId('page-frame-toolbar');
    expect(row).toHaveTextContent('Filter');
    expect(row).not.toHaveAttribute('data-override');
  });

  it('lets a banner REPLACE the toolbar row, never stack under it', () => {
    render(
      <PageFrame
        width="contained"
        toolbar={<button type="button">Filter</button>}
        toolbarOverride={<span>2 filters applied</span>}
      >
        <p />
      </PageFrame>,
    );
    expect(screen.getAllByTestId('page-frame-toolbar')).toHaveLength(1);
    expect(screen.getByTestId('page-frame-toolbar')).toHaveAttribute('data-override', 'true');
    expect(screen.queryByRole('button', { name: 'Filter' })).not.toBeInTheDocument();
    expect(screen.getByText('2 filters applied')).toBeInTheDocument();
  });

  it('is not a landmark — the shell owns <main> (rule 273)', () => {
    const { container } = render(
      <PageFrame width="contained">
        <p />
      </PageFrame>,
    );
    expect(container.querySelector('main')).toBeNull();
  });
});
