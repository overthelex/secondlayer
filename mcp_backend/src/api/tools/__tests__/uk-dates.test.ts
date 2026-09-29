import { datesToDays } from '../uk-dates';

// node-postgres parses a DATE as local midnight; under BST that is 23:00Z the day before.
describe('datesToDays', () => {
  it('keeps the calendar day of a DATE that falls in British Summer Time', () => {
    const bstDate = new Date(2016, 3, 6); // 2016-04-06 local midnight, as pg parses a DATE
    expect(datesToDays({ valid_from: bstDate })).toEqual({ valid_from: '2016-04-06' });
  });

  it('converts nested arrays and objects and leaves other values alone', () => {
    const out = datesToDays({
      history: [{ valid_from: new Date(2013, 0, 9), valid_to: null, n_chars: 63 }],
      label: '253',
    });
    expect(out).toEqual({ history: [{ valid_from: '2013-01-09', valid_to: null, n_chars: 63 }], label: '253' });
  });

  it('leaves a real timestamp (with a time of day) as a Date', () => {
    const ts = new Date(2026, 8, 28, 14, 30);
    expect(datesToDays({ at: ts }).at).toBe(ts);
  });
});
