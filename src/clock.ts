// A deterministic logical clock for the forge.
//
// Nothing the forge answers may depend on the machine's wall clock: a graded
// trial replays the same requests and expects the same shape of answer, and a
// timestamp that moves with the host would make two runs differ. Every
// created_at / updated_at / merged_at the forge emits, and every author or
// committer timestamp it writes into a commit it creates itself, comes from
// this clock: a fixed epoch plus a counter that ticks once per stamp. The
// counter only moves forward, so creation order and timestamp order always
// agree, which is what the issue list's CREATED_AT ordering rests on.

/** 2025-01-01T00:00:00Z: the forge's day one. */
export const CLOCK_EPOCH_SEC = 1_735_689_600;

export class LogicalClock {
  private tickCount = 0;

  /** The current logical time, in whole seconds since the Unix epoch. */
  nowSec(): number {
    return CLOCK_EPOCH_SEC + this.tickCount;
  }

  /** Advance the clock and return the new logical time in seconds. */
  tick(): number {
    this.tickCount += 1;
    return this.nowSec();
  }

  /** The current logical time as an ISO-8601 string, without advancing. */
  nowIso(): string {
    return isoOf(this.nowSec());
  }

  /** Advance the clock and return the new time as an ISO-8601 string. */
  tickIso(): string {
    return isoOf(this.tick());
  }
}

/** Format whole seconds since the Unix epoch as ISO-8601 (UTC, second precision). */
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A git timestamp line fragment: "<sec> +0000". */
export function gitStampOf(sec: number): string {
  return `${sec} +0000`;
}
