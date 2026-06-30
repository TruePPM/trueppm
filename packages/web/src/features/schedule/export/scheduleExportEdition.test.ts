import { describe, it, expect } from 'vitest';
import { scheduleExportFooterWatermark } from './scheduleExportEdition';

// The edition seam is the one-way OSS→Enterprise hook (mirrors boardExportEdition):
// the OSS build returns the Community watermark; Enterprise overrides it to null /
// a licensed footer. The contract under test is the SHAPE — a string-or-null with
// no enterprise import — not the literal copy.
describe('scheduleExportFooterWatermark (edition seam)', () => {
  it('returns a non-empty Community watermark string in the OSS build', () => {
    const watermark = scheduleExportFooterWatermark();
    expect(typeof watermark).toBe('string');
    expect(watermark).toContain('TruePPM');
    expect((watermark ?? '').length).toBeGreaterThan(0);
  });

  it('is a pure, side-effect-free read (stable across calls)', () => {
    expect(scheduleExportFooterWatermark()).toBe(scheduleExportFooterWatermark());
  });
});
