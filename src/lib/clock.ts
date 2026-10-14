export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock & { set(iso: string): void; advance(ms: number): void } {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set: (v: string) => {
      t = new Date(v).getTime();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
