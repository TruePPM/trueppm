/**
 * ComposerDirtyContext tests (#2153) — the aggregation that lets the task
 * drawer's unsaved-changes guard see unstaged composer text.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useState } from 'react';
import { ComposerDirtyProvider, useReportComposerDirty } from './ComposerDirtyContext';

/** Tiny composer stand-in whose "text" is driven from the outside. */
function FakeComposer({ hasText }: { hasText: boolean }) {
  useReportComposerDirty(hasText);
  return null;
}

describe('ComposerDirtyProvider', () => {
  it('reports dirty only on the empty↔non-empty transition', () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      <ComposerDirtyProvider onDirtyChange={onDirtyChange}>
        <FakeComposer hasText={false} />
      </ComposerDirtyProvider>,
    );
    // Mount with no text → no transition reported.
    expect(onDirtyChange).not.toHaveBeenCalled();

    rerender(
      <ComposerDirtyProvider onDirtyChange={onDirtyChange}>
        <FakeComposer hasText />
      </ComposerDirtyProvider>,
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // A second render with the same text must not re-fire.
    onDirtyChange.mockClear();
    rerender(
      <ComposerDirtyProvider onDirtyChange={onDirtyChange}>
        <FakeComposer hasText />
      </ComposerDirtyProvider>,
    );
    expect(onDirtyChange).not.toHaveBeenCalled();

    rerender(
      <ComposerDirtyProvider onDirtyChange={onDirtyChange}>
        <FakeComposer hasText={false} />
      </ComposerDirtyProvider>,
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('stays dirty until the LAST dirty composer clears (aggregate)', () => {
    const onDirtyChange = vi.fn();
    function Harness({ a, b }: { a: boolean; b: boolean }) {
      return (
        <ComposerDirtyProvider onDirtyChange={onDirtyChange}>
          <FakeComposer hasText={a} />
          <FakeComposer hasText={b} />
        </ComposerDirtyProvider>
      );
    }
    const { rerender } = render(<Harness a={false} b={false} />);

    rerender(<Harness a b={false} />); // one dirty
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    onDirtyChange.mockClear();
    rerender(<Harness a b />); // both dirty — aggregate already true, no re-fire
    expect(onDirtyChange).not.toHaveBeenCalled();

    rerender(<Harness a={false} b />); // one still dirty — stays true, no transition
    expect(onDirtyChange).not.toHaveBeenCalled();

    rerender(<Harness a={false} b={false} />); // last clears → false
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('clears a composer contribution when it unmounts', () => {
    const onDirtyChange = vi.fn();
    function Harness({ show }: { show: boolean }) {
      return (
        <ComposerDirtyProvider onDirtyChange={onDirtyChange}>
          {show && <FakeComposer hasText />}
        </ComposerDirtyProvider>
      );
    }
    const { rerender } = render(<Harness show />);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    rerender(<Harness show={false} />); // composer unmounts → cleanup reports false
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('is a safe no-op outside a provider', () => {
    // No provider in the tree — must not throw.
    function Standalone() {
      const [text] = useState(true);
      return <FakeComposer hasText={text} />;
    }
    expect(() => act(() => void render(<Standalone />))).not.toThrow();
  });
});
