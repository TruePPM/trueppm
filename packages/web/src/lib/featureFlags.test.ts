import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  applyFeatureFlagsFromUrl,
  coerceFlagMap,
  isFeatureFlagEnabled,
  setFeatureFlag,
  useFeatureFlag,
} from './featureFlags';

const STORAGE_KEY = 'trueppm.featureFlags';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('useFeatureFlag', () => {
  it('returns false for unknown flag with no override', () => {
    const { result } = renderHook(() => useFeatureFlag('does_not_exist'));
    expect(result.current).toBe(false);
  });

  it('returns true after setFeatureFlag override', () => {
    const { result } = renderHook(() => useFeatureFlag('schedule_build_mode_v1'));
    expect(result.current).toBe(false);
    act(() => setFeatureFlag('schedule_build_mode_v1', true));
    expect(result.current).toBe(true);
  });

  it('toggles back to false when override is removed', () => {
    const { result } = renderHook(() => useFeatureFlag('schedule_build_mode_v1'));
    act(() => setFeatureFlag('schedule_build_mode_v1', true));
    expect(result.current).toBe(true);
    act(() => setFeatureFlag('schedule_build_mode_v1', false));
    expect(result.current).toBe(false);
  });

  it('reads pre-existing localStorage values on first render', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schedule_build_mode_v1: true }),
    );
    const { result } = renderHook(() => useFeatureFlag('schedule_build_mode_v1'));
    expect(result.current).toBe(true);
  });

  it('treats malformed localStorage as empty', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    const { result } = renderHook(() => useFeatureFlag('schedule_build_mode_v1'));
    expect(result.current).toBe(false);
  });

  it('ignores non-boolean values in localStorage', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schedule_build_mode_v1: 'yes' }),
    );
    const { result } = renderHook(() => useFeatureFlag('schedule_build_mode_v1'));
    expect(result.current).toBe(false);
  });

  it('cross-flag isolation — toggling A does not affect B', () => {
    const { result: a } = renderHook(() => useFeatureFlag('flag_a'));
    const { result: b } = renderHook(() => useFeatureFlag('flag_b'));
    act(() => setFeatureFlag('flag_a', true));
    expect(a.current).toBe(true);
    expect(b.current).toBe(false);
  });
});

describe('isFeatureFlagEnabled', () => {
  it('reads the same store as the hook', () => {
    expect(isFeatureFlagEnabled('schedule_build_mode_v1')).toBe(false);
    setFeatureFlag('schedule_build_mode_v1', true);
    expect(isFeatureFlagEnabled('schedule_build_mode_v1')).toBe(true);
  });
});

describe('coerceFlagMap (validation branches)', () => {
  it('returns empty for null', () => {
    expect(coerceFlagMap(null)).toEqual({});
  });

  it('returns empty for undefined', () => {
    expect(coerceFlagMap(undefined)).toEqual({});
  });

  it('returns empty for a string (not an object)', () => {
    expect(coerceFlagMap('schedule_build_mode_v1')).toEqual({});
  });

  it('returns empty for an array (typeof === object but Array.isArray)', () => {
    expect(coerceFlagMap(['schedule_build_mode_v1'])).toEqual({});
  });

  it('returns empty for a number', () => {
    expect(coerceFlagMap(42)).toEqual({});
  });

  it('keeps boolean values, drops non-boolean values silently', () => {
    expect(
      coerceFlagMap({
        flag_a: true,
        flag_b: false,
        flag_c: 'yes',
        flag_d: 1,
        flag_e: null,
      }),
    ).toEqual({ flag_a: true, flag_b: false });
  });

  it('returns an empty map for an empty object', () => {
    expect(coerceFlagMap({})).toEqual({});
  });
});

describe('applyFeatureFlagsFromUrl', () => {
  const origUrl = window.location.href;

  afterEach(() => {
    window.history.replaceState(null, '', origUrl);
  });

  it('sets the flag and strips the param from the URL', () => {
    window.history.replaceState(null, '', '/?ff=schedule_build_mode_v1');
    applyFeatureFlagsFromUrl();
    expect(isFeatureFlagEnabled('schedule_build_mode_v1')).toBe(true);
    expect(window.location.search).not.toContain('ff=');
  });

  it('handles comma-separated multi-flag', () => {
    window.history.replaceState(null, '', '/?ff=flag_a,flag_b');
    applyFeatureFlagsFromUrl();
    expect(isFeatureFlagEnabled('flag_a')).toBe(true);
    expect(isFeatureFlagEnabled('flag_b')).toBe(true);
  });

  it('is a no-op when ff param is absent', () => {
    window.history.replaceState(null, '', '/');
    applyFeatureFlagsFromUrl();
    expect(isFeatureFlagEnabled('schedule_build_mode_v1')).toBe(false);
  });
});
