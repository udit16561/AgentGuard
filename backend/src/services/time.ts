/** Wall-clock parts of an instant in a time zone, without a date library. */
export function zonedParts(ms: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(ms).map(p => [p.type, p.value]));
  const [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(k => Number(parts[k]));
  const offset = Date.UTC(y, mo - 1, d, h, mi, s) - (ms - (ms % 1000));
  return { startOfDay: Date.UTC(y, mo - 1, d) - offset, minuteOfDay: h * 60 + mi };
}

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

/** True when `minuteOfDay` falls outside [start, end); windows may cross midnight (22:00–06:00). */
export function outsideWindow(minuteOfDay: number, window: { start: string; end: string }) {
  const s = minutes(window.start), e = minutes(window.end);
  const inside = s <= e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
  return !inside;
}
