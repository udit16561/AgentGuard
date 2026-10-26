const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = typeof WEEKDAYS[number];
export { WEEKDAYS };

/** Wall-clock parts of an instant in a time zone, without a date library. Weeks start on Monday. */
export function zonedParts(ms: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(ms).map(p => [p.type, p.value]));
  const [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(k => Number(parts[k]));
  const offset = Date.UTC(y, mo - 1, d, h, mi, s) - (ms - (ms % 1000));
  const weekday = WEEKDAYS.indexOf(String(parts.weekday).slice(0, 3).toLowerCase() as Weekday);
  const startOfDay = Date.UTC(y, mo - 1, d) - offset;
  return {
    startOfDay, minuteOfDay: h * 60 + mi, weekday: WEEKDAYS[weekday],
    startOfWeek: startOfDay - weekday * 86_400_000,
    startOfMonth: Date.UTC(y, mo - 1, 1) - offset
  };
}

export const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** True when `minuteOfDay` falls outside [start, end); windows may cross midnight (22:00–06:00). */
export function outsideWindow(minuteOfDay: number, window: { start: string; end: string }) {
  const s = minutes(window.start), e = minutes(window.end);
  const inside = s <= e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
  return !inside;
}
