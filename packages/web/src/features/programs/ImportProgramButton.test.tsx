import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportProgramButton } from './ImportProgramButton';

const importMutate = vi.fn();

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useImportProgramSeed: () => ({ mutate: importMutate, isPending: false }),
  useProgramImportStatus: () => ({ data: undefined }),
  seedImportErrors: () => [],
  seedReplaceConflict: () => null,
}));

function throttled(retryAfter: string) {
  return new AxiosError('throttled', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 429,
    statusText: 'Too Many Requests',
    data: {},
    headers: new AxiosHeaders({ 'retry-after': retryAfter }),
    config: { headers: new AxiosHeaders() },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('ImportProgramButton rate limiting (#2432)', () => {
  it('names the Retry-After wait, disables the trigger, and shows no generic failure on a 429', async () => {
    importMutate.mockImplementation((_input: unknown, opts: { onError: (e: unknown) => void }) =>
      opts.onError(throttled('42')),
    );
    render(
      <MemoryRouter>
        <ImportProgramButton />
      </MemoryRouter>,
    );
    const file = new File(['{}'], 'seed.json', { type: 'application/json' });
    await userEvent.upload(screen.getByTestId('program-seed-file-input'), file);

    expect(screen.getByRole('alert')).toHaveTextContent('Pick the file again in 42 seconds');
    expect(screen.queryByText(/Could not import this file/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Import from JSON' })).toBeDisabled();
  });
});
