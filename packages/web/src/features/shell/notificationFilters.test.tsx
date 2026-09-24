import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { notificationEmptyCopy } from './notificationFilters';

function svgOf(icon: ReactNode): SVGSVGElement {
  const { container } = render(<>{icon}</>);
  return container.querySelector('svg') as SVGSVGElement;
}

describe('notificationEmptyCopy', () => {
  it('names notifications, not mentions, for Unread + All', () => {
    const copy = notificationEmptyCopy('unread', 'all');
    expect(copy.title).toBe("You're all caught up");
    expect(copy.body).toBe('No unread notifications right now.');
    expect(copy.body).not.toMatch(/mention/i);
  });

  it('keeps the read-state All + All copy category-neutral', () => {
    expect(notificationEmptyCopy('all', 'all').body).not.toMatch(/^When someone @-mentions/);
  });

  it('leaves category-scoped copy unchanged', () => {
    expect(notificationEmptyCopy('unread', 'mentions').body).toMatch(/^No unread .+ right now\.$/);
    expect(notificationEmptyCopy('all', 'tasks').body).toMatch(/^No .+ to show yet\.$/);
  });

  it('renders the caught-up icon as a static check in a circle, not radial strokes', () => {
    const svg = svgOf(notificationEmptyCopy('unread', 'all').icon);
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(svg.querySelectorAll('path')).toHaveLength(1);
  });
});
