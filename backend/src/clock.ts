/** Injectable time source, so tests can jump past the approval window (SEC-07). */
export interface Clock {
  now(): number;
  advanceMinutes(minutes: number): void;
}

export function createClock(): Clock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advanceMinutes: (minutes: number) => { offset += minutes * 60_000; }
  };
}
