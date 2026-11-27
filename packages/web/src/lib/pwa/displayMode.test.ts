import { describe, expect, it } from 'vitest';
import { isIos, isIosSafari, isStandalone } from './displayMode';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';
const IPHONE_INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';

describe('isIos', () => {
  it('recognizes an iPhone', () => {
    expect(isIos({ userAgent: IPHONE_SAFARI })).toBe(true);
  });
  it('recognizes an iPad that reports a desktop Mac user agent', () => {
    expect(isIos({ userAgent: IPAD_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true,
    );
  });
  it('does not mistake a real Mac (no touch points) for an iPad', () => {
    expect(isIos({ userAgent: IPAD_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false,
    );
  });
  it('rejects Android and a missing navigator', () => {
    expect(isIos({ userAgent: ANDROID_CHROME })).toBe(false);
    expect(isIos(null)).toBe(false);
  });
});

describe('isIosSafari', () => {
  it('is true for iPhone Safari', () => {
    expect(isIosSafari({ userAgent: IPHONE_SAFARI })).toBe(true);
  });
  it('is false for Chrome on iOS and for in-app browsers', () => {
    expect(isIosSafari({ userAgent: IPHONE_CHROME })).toBe(false);
    expect(isIosSafari({ userAgent: IPHONE_INSTAGRAM })).toBe(false);
  });
  it('is false on Android', () => {
    expect(isIosSafari({ userAgent: ANDROID_CHROME })).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is true when display-mode standalone matches', () => {
    expect(isStandalone({ userAgent: ANDROID_CHROME }, true)).toBe(true);
  });
  it('is true for the iOS navigator.standalone flag', () => {
    expect(isStandalone({ userAgent: IPHONE_SAFARI, standalone: true }, false)).toBe(true);
  });
  it('is false in a browser tab', () => {
    expect(isStandalone({ userAgent: IPHONE_SAFARI, standalone: false }, false)).toBe(false);
    expect(isStandalone(null, false)).toBe(false);
  });
});
