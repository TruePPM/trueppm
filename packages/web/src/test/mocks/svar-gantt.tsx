// Test mock for @svar-ui/react-gantt — Canvas is not available in jsdom.
// The real Gantt component uses HTMLCanvasElement internally; this mock renders
// a simple div so App-level and shell tests can render without error.
import type { IApi } from '@svar-ui/gantt-store';

interface GanttProps {
  tasks?: unknown[];
  links?: unknown[];
  zoom?: unknown;
  readonly?: boolean;
  init?: (api: IApi) => void;
}

export function Gantt({ init }: GanttProps) {
  // Call init with a minimal stub so useScrollSync and onApiReady don't throw
  if (init) {
    const stubApi = {
      exec: () => Promise.resolve(undefined),
      on: () => {},
      intercept: () => {},
      setNext: () => {},
      getState: () => ({ scrollLeft: 0, _scales: undefined }),
      getReactiveState: () => ({}),
      getStores: () => ({ data: {} }),
      getTable: () => ({}),
      getTask: () => ({}),
      detach: () => {},
      serialize: () => [],
    } as unknown as IApi;
    init(stubApi);
  }
  return <div data-testid="gantt-mock" aria-label="Gantt chart" />;
}
