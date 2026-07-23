import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSettingsHotkey } from './useSettingsHotkey';

const navigate = vi.fn();
vi.mock('react-router', () => ({ useNavigate: () => navigate }));

const isWorkspaceAdmin = vi.fn<() => boolean | null>(() => false);
vi.mock('@/hooks/useIsWorkspaceAdmin', () => ({
  useIsWorkspaceAdmin: () => isWorkspaceAdmin(),
}));

function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...opts }));
}

describe('useSettingsHotkey (#2298)', () => {
  beforeEach(() => {
    navigate.mockClear();
    isWorkspaceAdmin.mockReturnValue(false);
  });

  it('routes a workspace admin to /settings on ⌘,', () => {
    isWorkspaceAdmin.mockReturnValue(true);
    renderHook(() => useSettingsHotkey());
    press(',', { metaKey: true });
    expect(navigate).toHaveBeenCalledWith('/settings');
  });

  it('routes a non-admin to personal settings on Ctrl+,', () => {
    renderHook(() => useSettingsHotkey());
    press(',', { ctrlKey: true });
    expect(navigate).toHaveBeenCalledWith('/me/settings/general');
  });

  it('routes an unresolved role (null) to personal settings — the safe default', () => {
    isWorkspaceAdmin.mockReturnValue(null);
    renderHook(() => useSettingsHotkey());
    press(',', { metaKey: true });
    expect(navigate).toHaveBeenCalledWith('/me/settings/general');
  });

  it('ignores a bare comma with no modifier', () => {
    renderHook(() => useSettingsHotkey());
    press(',');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores the chord when Shift or Alt is also held', () => {
    renderHook(() => useSettingsHotkey());
    press(',', { metaKey: true, shiftKey: true });
    press(',', { metaKey: true, altKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});
