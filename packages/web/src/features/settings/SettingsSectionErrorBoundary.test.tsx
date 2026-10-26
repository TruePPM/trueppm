import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { render } from '@testing-library/react';
import util from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SettingsSectionErrorBoundary } from './SettingsSectionErrorBoundary';

function Bomb(): never {
  const config = {
    method: 'get',
    url: '/api/v1/x/',
    headers: new AxiosHeaders({ Authorization: 'Bearer secret-access-token-123' }),
  } as InternalAxiosRequestConfig;
  throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config);
}

describe('SettingsSectionErrorBoundary', () => {
  it('never logs an AxiosError Authorization header (#3562)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <SettingsSectionErrorBoundary sectionId="general">
        <Bomb />
      </SettingsSectionErrorBoundary>,
    );
    const ours = spy.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('[SettingsSectionErrorBoundary]'),
    );
    expect(ours.length).toBeGreaterThan(0);
    expect(util.inspect(ours, { depth: 6 })).not.toContain('secret-access-token');
    spy.mockRestore();
  });
});
