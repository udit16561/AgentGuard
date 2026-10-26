/** Injectable time source, so tests can jump past the approval window (SEC-07) or start at a fixed instant. */
export interface Clock {
  now(): number;
  advanceMinutes(minutes: number): void;
}

/** `start` pins "now" to a fixed instant that only moves with advanceMinutes (tests); without it, real time. */
export function createClock(start?: number): Clock {
  let offset = 0;
  return {
    now: () => (start ?? Date.now()) + offset,
    advanceMinutes: (minutes: number) => { offset += minutes * 60_000; }
  };
}
