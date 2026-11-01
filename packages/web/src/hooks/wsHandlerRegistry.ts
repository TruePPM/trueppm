/**
 * Additive event-handler table for `useProjectWebSocket`.
 *
 * `on()` used to be `table[t] = handler`, so a second registration for an event type
 * silently replaced the first and the symptom was the OLD invalidation vanishing
 * (rule 331). Handlers now accumulate per event type and all run on dispatch.
 */

export type WsHandler = (payload: Record<string, unknown>, event_type: string) => void;

export type WsHandlerTable = Record<string, WsHandler[]>;

export type Unsubscribe = () => void;

/**
 * Registers `handler` under each type. Returns an unsubscribe that removes only this
 * registration, leaving sibling handlers for the same type in place.
 */
export function addHandler(
  table: WsHandlerTable,
  types: string | readonly string[],
  handler: WsHandler,
): Unsubscribe {
  const list = typeof types === 'string' ? [types] : types;
  for (const t of list) (table[t] ||= []).push(handler);
  return () => {
    for (const t of list) {
      const arr = table[t];
      if (!arr) continue;
      const i = arr.indexOf(handler);
      if (i !== -1) arr.splice(i, 1);
    }
  };
}

/**
 * Runs every handler registered for `eventType`, in registration order.
 *
 * Each call is isolated: one handler throwing must not stop its siblings, because
 * they are independent cache invalidations and a bug in one would otherwise
 * silently starve the others for that event. The error is logged, not rethrown.
 * `Object.hasOwn` keeps an inherited key such as "constructor" arriving off the wire
 * from resolving to a prototype member (CodeQL js/unvalidated-dynamic-method-call).
 */
export function dispatchHandlers(
  table: WsHandlerTable,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (!Object.hasOwn(table, eventType)) return;
  // Snapshot so a handler that (un)subscribes mid-dispatch cannot skip a sibling.
  for (const handler of [...table[eventType]]) {
    try {
      handler(payload, eventType);
    } catch (err) {
      console.error(`useProjectWebSocket: handler for "${eventType}" threw`, err);
    }
  }
}
