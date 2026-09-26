import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, useLocation } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AxiosError, AxiosHeaders } from 'axios';

import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { ProgramRefBoundary, ProjectRefBoundary } from './RefBoundary';

// The global test setup swaps useResolveRef for an identity resolver; this file is
// about the real one, so restore it.
vi.mock('@/hooks/useResolveRef', async (importOriginal) => importOriginal());

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/api/client', () => ({ apiClient: { get: getMock } }));

// The shell frame and the not-found body are real; nothing else in ProjectShell
// is rendered by the boundary, but its module imports hooks that touch sockets.
vi.mock('@/hooks/useProjectWebSocket', () => ({ useProjectWebSocket: () => undefined }));

const PROJECT_ID = '6f1c2b1e-9a57-4c1e-8d4f-2a0b7c9e1d33';
const PROGRAM_ID = '0b8f5c7e-1d2a-4e3b-9c4d-5e6f7a8b9c0d';

function notFound(): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('Not found', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    data: { detail: 'Not found.' },
    headers,
    config: { headers },
  });
}

type Responder = (url: string, params: Record<string, string> | undefined) => unknown;

function serve(responder: Responder) {
  getMock.mockImplementation((url: string, config?: { params?: Record<string, string> }) => {
    try {
      return Promise.resolve({ data: responder(url, config?.params) });
    } catch (err) {
      return Promise.reject(err as Error);
    }
  });
}

function resolveCalls() {
  return getMock.mock.calls.filter(([url]) => url === '/resolve/');
}

function ProjectProbe() {
  const id = useProjectId();
  const location = useLocation();
  return (
    <div>
      <span data-testid="id">{id}</span>
      <span data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</span>
    </div>
  );
}

function ProgramProbe() {
  const id = useProgramId();
  const location = useLocation();
  return (
    <div>
      <span data-testid="id">{id}</span>
      <span data-testid="where">{location.pathname}</span>
    </div>
  );
}

function renderAt(
  path: string,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const router = createMemoryRouter(
    [
      {
        path: '/projects/:projectId/*',
        element: (
          <ProjectRefBoundary>
            <ProjectProbe />
          </ProjectRefBoundary>
        ),
      },
      {
        path: '/programs/:programId/*',
        element: (
          <ProgramRefBoundary>
            <ProgramProbe />
          </ProgramRefBoundary>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  getMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectRefBoundary', () => {
  it('resolves a key URL and provides the UUID below the boundary', async () => {
    serve((url, params) => {
      if (url === '/resolve/') {
        expect(params).toEqual({ kind: 'project', ref: 'PLAT' });
        return {
          type: 'project',
          id: PROJECT_ID,
          project_id: PROJECT_ID,
          program_id: null,
          key: 'PLAT',
          canonical_ref: 'PLAT',
        };
      }
      return { id: PROJECT_ID, code: 'PLAT' };
    });
    renderAt('/projects/PLAT/board');
    expect(await screen.findByTestId('id')).toHaveTextContent(PROJECT_ID);
    expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/board');
    expect(resolveCalls()).toHaveLength(1);
  });

  it('passes a reference to the resolver raw — the web never splits it', async () => {
    serve(() => {
      throw notFound();
    });
    renderAt('/projects/GA-SEC-T-10');
    await screen.findByText(/This project isn.t available/);
    expect(resolveCalls()[0]?.[1]).toEqual({ params: { kind: 'project', ref: 'GA-SEC-T-10' } });
  });

  it('rewrites a retired key to the current one, keeping path, query and hash', async () => {
    serve((url) =>
      url === '/resolve/'
        ? {
            type: 'project',
            id: PROJECT_ID,
            project_id: PROJECT_ID,
            program_id: null,
            key: 'PLAT',
            canonical_ref: 'PLAT',
          }
        : { id: PROJECT_ID, code: 'PLAT' },
    );
    renderAt('/projects/OLDKEY/settings?tab=a#key');
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/settings?tab=a#key'),
    );
    expect(screen.getByTestId('id')).toHaveTextContent(PROJECT_ID);
  });

  it('rewrites a cached UUID URL to the key without calling the resolver', async () => {
    // Only the project detail may be (re)fetched — never the resolver.
    serve((url) => {
      if (url === '/resolve/') throw new Error('resolver must not be called');
      return { id: PROJECT_ID, code: 'PLAT' };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['project', PROJECT_ID], { id: PROJECT_ID, code: 'PLAT' });
    renderAt(`/projects/${PROJECT_ID}/schedule`, client);
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/schedule'),
    );
    expect(screen.getByTestId('id')).toHaveTextContent(PROJECT_ID);
    expect(resolveCalls()).toHaveLength(0);
  });

  it('never sends a UUID to the resolver, even when nothing is cached', async () => {
    serve((url) => {
      if (url === '/resolve/') throw new Error('resolver must not be called for a UUID');
      return { id: PROJECT_ID, code: 'PLAT' };
    });
    renderAt(`/projects/${PROJECT_ID}/board`);
    // The id is known immediately; the key arrives with the project detail.
    expect(await screen.findByTestId('id')).toHaveTextContent(PROJECT_ID);
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/board'),
    );
    expect(resolveCalls()).toHaveLength(0);
  });

  it('keeps a keyless project on its UUID URL', async () => {
    serve(() => ({ id: PROJECT_ID, code: '' }));
    renderAt(`/projects/${PROJECT_ID}/board`);
    expect(await screen.findByTestId('id')).toHaveTextContent(PROJECT_ID);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.getByTestId('where')).toHaveTextContent(`/projects/${PROJECT_ID}/board`);
  });

  it('answers a differently-cased key from the cache and canonicalizes its case', async () => {
    // Only the project detail may be (re)fetched — never the resolver.
    serve((url) => {
      if (url === '/resolve/') throw new Error('resolver must not be called');
      return { id: PROJECT_ID, code: 'PLAT' };
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['project', PROJECT_ID], { id: PROJECT_ID, code: 'PLAT' });
    renderAt('/projects/plat/overview', client);
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/projects/PLAT/overview'),
    );
    expect(resolveCalls()).toHaveLength(0);
  });

  it('renders the existing not-found state for an unknown key — same as an invisible UUID', async () => {
    serve(() => {
      throw notFound();
    });
    renderAt('/projects/NOPE/board');
    expect(await screen.findByText(/This project isn.t available/)).toBeInTheDocument();
    expect(screen.queryByTestId('id')).not.toBeInTheDocument();
  });

  it('renders the shell frame, not the page, while the key resolves', () => {
    getMock.mockImplementation(() => new Promise(() => undefined));
    renderAt('/projects/PLAT/board');
    expect(screen.queryByTestId('id')).not.toBeInTheDocument();
    expect(screen.queryByText(/This project isn.t available/)).not.toBeInTheDocument();
  });

  it('says the link needs a connection for an unresolved key opened offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    getMock.mockImplementation(() => new Promise(() => undefined));
    renderAt('/projects/PLAT/board');
    expect(
      await screen.findByText('This link needs a connection the first time it’s opened.'),
    ).toBeInTheDocument();
  });
});

describe('ProgramRefBoundary', () => {
  it('resolves a program key and provides the UUID', async () => {
    serve((url, params) => {
      if (url === '/resolve/') {
        expect(params).toEqual({ kind: 'program', ref: 'atlas-platform-launch' });
        return {
          type: 'program',
          id: PROGRAM_ID,
          project_id: null,
          program_id: PROGRAM_ID,
          key: 'atlas-platform-launch',
          canonical_ref: 'atlas-platform-launch',
        };
      }
      return { id: PROGRAM_ID, code: 'atlas-platform-launch' };
    });
    renderAt('/programs/atlas-platform-launch/overview');
    expect(await screen.findByTestId('id')).toHaveTextContent(PROGRAM_ID);
  });

  it('rewrites a program UUID URL to its key', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['programs', PROGRAM_ID], { id: PROGRAM_ID, code: 'atlas' });
    serve((url) => {
      if (url === '/resolve/') throw new Error('resolver must not be called');
      return { id: PROGRAM_ID, code: 'atlas' };
    });
    renderAt(`/programs/${PROGRAM_ID}/backlog`, client);
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/programs/atlas/backlog'),
    );
  });

  it('renders the app not-found page for an unknown program key', async () => {
    serve(() => {
      throw notFound();
    });
    renderAt('/programs/nope/overview');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
