import { DUPLICATE_CONFIG_FILE } from '@open-estate/shared';
import { duplicateSweepSettings, sweepScheduleExpression } from '../src/duplicate-sweep';

// Schedule of the Duplikat_Abgleich from `duplicate-detection.json` (duplicate-detection Req 10.1).

describe('schedule of the Duplikat_Abgleich', () => {
  it('runs daily at the configured UTC time, 03:00 without configuration', () => {
    expect(duplicateSweepSettings([])).toEqual({ timeUtc: '03:00' });
    const file = {
      key: DUPLICATE_CONFIG_FILE,
      content: JSON.stringify({ sweep: { timeUtc: '04:30', segments: 4 } }),
    };
    expect(duplicateSweepSettings([file])).toEqual({ timeUtc: '04:30' });
    expect(sweepScheduleExpression('03:00')).toBe('cron(0 3 * * ? *)');
    expect(sweepScheduleExpression('23:59')).toBe('cron(59 23 * * ? *)');
    expect(sweepScheduleExpression('04:05')).toBe('cron(5 4 * * ? *)');
  });

  it('rejects malformed times and configuration', () => {
    expect(() => sweepScheduleExpression('24:00')).toThrow(/HH:MM/);
    expect(() => sweepScheduleExpression('3:00')).toThrow(/HH:MM/);
    const invalid = { key: DUPLICATE_CONFIG_FILE, content: '{"sweep":{"timeUtc":"25:00"}}' };
    expect(() => duplicateSweepSettings([invalid])).toThrow();
  });
});
