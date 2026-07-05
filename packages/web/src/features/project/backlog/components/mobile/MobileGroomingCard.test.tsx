import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/types';
import { MobileGroomingCard } from './MobileGroomingCard';

function story(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T-001',
    shortId: 'S-1',
    name: 'Failover handling',
    taskType: 'story',
    dor: 'refine',
    storyPoints: 3,
    acMet: 1,
    acTotal: 3,
    assignees: [],
    serverVersion: 1,
    ...overrides,
  } as Task;
}

// jsdom has no PointerEvent constructor, so fireEvent.pointerMove drops clientX.
// A MouseEvent carries clientX and, dispatched under a `pointer*` type name, still
// triggers React's synthetic pointer handlers.
function firePointer(el: Element, type: string, clientX: number) {
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
}

function renderCard(props: Partial<Parameters<typeof MobileGroomingCard>[0]> = {}) {
  const onOpen = vi.fn();
  const onToggleDor = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MobileGroomingCard story={props.story ?? story()} onOpen={onOpen} onToggleDor={onToggleDor} />
    </QueryClientProvider>,
  );
  return { onOpen, onToggleDor, ...utils };
}

describe('MobileGroomingCard (issue 1044)', () => {
  it('renders the story identity, points and readiness chip', () => {
    renderCard({ story: story({ shortId: 'S-42', name: 'Signal smoothing', storyPoints: 5 }) });
    expect(screen.getByText('S-42')).toBeInTheDocument();
    expect(screen.getByText('Signal smoothing')).toBeInTheDocument();
    expect(screen.getByText('5 pts')).toBeInTheDocument();
  });

  it('renders an em dash when the story is unestimated', () => {
    renderCard({ story: story({ storyPoints: null }) });
    expect(screen.getByText('— pts')).toBeInTheDocument();
  });

  it('flags an over-sized story (>= 8 points) with the at-risk tone', () => {
    renderCard({ story: story({ storyPoints: 13 }) });
    expect(screen.getByText('13 pts').className).toContain('text-semantic-at-risk');
  });

  it('opens the drawer on a plain tap of the card', () => {
    const { onOpen } = renderCard();
    fireEvent.click(screen.getByTestId('grooming-card'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the drawer on Enter and Space, ignores other keys', () => {
    const { onOpen } = renderCard();
    const card = screen.getByTestId('grooming-card');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    fireEvent.keyDown(card, { key: 'a' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('toggles readiness from the chip button without opening the drawer', () => {
    const { onOpen, onToggleDor } = renderCard();
    fireEvent.click(screen.getByLabelText('Toggle readiness for Failover handling'));
    expect(onToggleDor).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('commits a readiness toggle on a right swipe past the threshold', () => {
    const { onToggleDor } = renderCard();
    const card = screen.getByTestId('grooming-card');
    firePointer(card, 'pointerdown', 0);
    firePointer(card, 'pointermove', 40);
    expect(screen.getByText('→ Ready').className).not.toContain('opacity-0');
    firePointer(card, 'pointermove', 90);
    firePointer(card, 'pointerup', 90);
    expect(onToggleDor).toHaveBeenCalledTimes(1);
  });

  it('reveals the refine affordance on a left swipe', () => {
    const { onToggleDor } = renderCard();
    const card = screen.getByTestId('grooming-card');
    firePointer(card, 'pointerdown', 100);
    firePointer(card, 'pointermove', 20);
    expect(screen.getByText('Refine ←').className).not.toContain('opacity-0');
    firePointer(card, 'pointerup', 20);
    expect(onToggleDor).toHaveBeenCalledTimes(1);
  });

  it('suppresses the drawer-open click after a swipe moved the pointer', () => {
    const { onOpen, onToggleDor } = renderCard();
    const card = screen.getByTestId('grooming-card');
    firePointer(card, 'pointerdown', 0);
    firePointer(card, 'pointermove', 90);
    firePointer(card, 'pointerup', 90);
    fireEvent.click(card);
    expect(onToggleDor).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('does not commit a toggle for a sub-threshold nudge and resets on cancel', () => {
    const { onToggleDor } = renderCard();
    const card = screen.getByTestId('grooming-card');
    firePointer(card, 'pointerdown', 0);
    firePointer(card, 'pointermove', 5);
    firePointer(card, 'pointerup', 5);
    firePointer(card, 'pointercancel', 5);
    expect(onToggleDor).not.toHaveBeenCalled();
  });

  it('ignores a stray pointer move with no active gesture', () => {
    const { onToggleDor } = renderCard();
    const card = screen.getByTestId('grooming-card');
    firePointer(card, 'pointermove', 90);
    expect(onToggleDor).not.toHaveBeenCalled();
  });
});
