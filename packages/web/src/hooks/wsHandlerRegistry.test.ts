import { describe, it, expect, vi, afterEach } from 'vitest';
import { addHandler, dispatchHandlers, type WsHandlerTable } from './wsHandlerRegistry';

describe('wsHandlerRegistry (#3050)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs both handlers registered for the same event type, in order', () => {
    const table: WsHandlerTable = {};
    const calls: string[] = [];
    addHandler(table, 'e', () => calls.push('first'));
    addHandler(table, 'e', () => calls.push('second'));
    dispatchHandlers(table, 'e', {});
    expect(calls).toEqual(['first', 'second']);
  });

  it('passes payload and event type; grouped registration fires per member', () => {
    const table: WsHandlerTable = {};
    const h = vi.fn();
    addHandler(table, ['a', 'b'], h);
    dispatchHandlers(table, 'b', { id: 1 });
    expect(h).toHaveBeenCalledWith({ id: 1 }, 'b');
  });

  it('unsubscribing one handler leaves the others', () => {
    const table: WsHandlerTable = {};
    const a = vi.fn();
    const b = vi.fn();
    const offA = addHandler(table, ['e', 'f'], a);
    addHandler(table, 'e', b);
    offA();
    dispatchHandlers(table, 'e', {});
    dispatchHandlers(table, 'f', {});
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a throwing handler does not block its siblings and is logged', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const table: WsHandlerTable = {};
    const after = vi.fn();
    addHandler(table, 'e', () => {
      throw new Error('boom');
    });
    addHandler(table, 'e', after);
    expect(() => dispatchHandlers(table, 'e', {})).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();
  });

  it('ignores unknown and inherited prototype keys', () => {
    const table: WsHandlerTable = {};
    expect(() => dispatchHandlers(table, 'constructor', {})).not.toThrow();
    expect(() => dispatchHandlers(table, 'nope', {})).not.toThrow();
  });
});
