/**
 * Borsh encoding of the executor's SwapPlan (packages/position-executor/src/lib.rs).
 * The router forwards these bytes untouched and the executor validates them, so the layout here
 * must match the Rust struct field for field; executorPlan.test.ts pins it to a vector from the
 * router's tests.
 */

export type ExecVenue = 'Dcl' | 'RefAmm' | 'Intear' | 'Shardsmarket' | 'BondingCurve' | 'Launchpad';
const VENUE_INDEX: Record<ExecVenue, number> = { Dcl: 0, RefAmm: 1, Intear: 2, Shardsmarket: 3, BondingCurve: 4, Launchpad: 5 };

export interface ExecHop {
  pool_id: number | null;
  dcl_pool_id: string | null;
  token_in: string;
  token_out: string;
  min_amount_out: string;
}

export interface ExecPlan {
  venue: ExecVenue;
  token: string;
  hops: ExecHop[];
  amount_in: string;
  min_amount_out: string;
  receiver: string | null;
  deadline_sec: number;
  correlation_id: string;
  custom_msg?: string | null;
}

class Writer {
  private parts: Buffer[] = [];
  u8(v: number) { this.parts.push(Buffer.from([v])); }
  u32(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); }
  u64(v: number | bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); }
  u128(v: string | bigint) {
    const n = BigInt(v);
    if (n < 0n || n >= 1n << 128n) throw new Error(`u128 out of range: ${v}`);
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(n & ((1n << 64n) - 1n), 0);
    b.writeBigUInt64LE(n >> 64n, 8);
    this.parts.push(b);
  }
  str(v: string) { const b = Buffer.from(v, 'utf8'); this.u32(b.length); this.parts.push(b); }
  option<T>(v: T | null | undefined, write: (x: T) => void) {
    if (v === null || v === undefined) this.u8(0);
    else { this.u8(1); write(v); }
  }
  bytes(): Buffer { return Buffer.concat(this.parts); }
}

export function encodeExecPlan(p: ExecPlan): Buffer {
  const w = new Writer();
  w.u8(VENUE_INDEX[p.venue]);
  w.str(p.token);
  w.u32(p.hops.length);
  for (const h of p.hops) {
    w.option(h.pool_id, v => w.u64(v));
    w.option(h.dcl_pool_id, v => w.str(v));
    w.str(h.token_in);
    w.str(h.token_out);
    w.u128(h.min_amount_out);
  }
  w.u128(p.amount_in);
  w.u128(p.min_amount_out);
  w.option(p.receiver, v => w.str(v));
  w.u64(p.deadline_sec);
  w.str(p.correlation_id);
  w.option(p.custom_msg, v => w.str(v));
  return w.bytes();
}
