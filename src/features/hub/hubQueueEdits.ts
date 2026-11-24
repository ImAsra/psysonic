import type { QueueItemRef } from '@/lib/media/trackTypes';

// Queue edits a remote sends to the playing device. Only the playing device saves the shared queue,
// so a remote describes its edit (which tracks, which positions) and the player applies it.
// The hub drops command arguments over 2048 bytes of JSON, so long lists travel in several parts.

/** JSON bytes one command's arguments may use (the hub's limit is 2048). */
export const HUB_ARGS_BUDGET = 1800;

/** Splits `ids` into parts whose arguments, together with `base`, stay within the budget. */
export function chunkIds(ids: readonly string[], base: Record<string, unknown>, budget = HUB_ARGS_BUDGET): string[][] {
  const overhead = JSON.stringify({ ...base, ids: [] }).length;
  const parts: string[][] = [];
  let part: string[] = [];
  let size = overhead;
  for (const id of ids) {
    const cost = JSON.stringify(id).length + 1;
    if (part.length && size + cost > budget) {
      parts.push(part);
      part = [];
      size = overhead;
    }
    part.push(id);
    size += cost;
  }
  if (part.length) parts.push(part);
  return parts;
}

/** Queue positions with the track each one held when the remote saw it. */
export interface QueuePositions {
  i: number[];
  id: string[];
}

/** Splits positions into parts that fit the budget (each part can be applied on its own). */
export function chunkPositions(
  positions: readonly { i: number; id: string }[],
  budget = HUB_ARGS_BUDGET,
): QueuePositions[] {
  const overhead = JSON.stringify({ i: [], id: [] }).length;
  const parts: QueuePositions[] = [];
  let part: QueuePositions = { i: [], id: [] };
  let size = overhead;
  for (const p of positions) {
    const cost = String(p.i).length + JSON.stringify(p.id).length + 2;
    if (part.i.length && size + cost > budget) {
      parts.push(part);
      part = { i: [], id: [] };
      size = overhead;
    }
    part.i.push(p.i);
    part.id.push(p.id);
    size += cost;
  }
  if (part.i.length) parts.push(part);
  return parts;
}

/** Reads `{ i, id }` from command arguments; null when they are malformed. */
export function readPositions(args: Record<string, unknown> | null): QueuePositions | null {
  const i = args?.i;
  const id = args?.id;
  if (!Array.isArray(i) || !Array.isArray(id) || i.length !== id.length) return null;
  if (!i.every(n => Number.isInteger(n) && n >= 0) || !id.every(s => typeof s === 'string')) return null;
  return { i: i as number[], id: id as string[] };
}

/**
 * The queue entries a remote meant. Each position is taken when it still holds the track the remote
 * saw; otherwise the first other entry with that track. Entries that are gone are skipped.
 */
export function pickQueueRefs(items: readonly QueueItemRef[], positions: QueuePositions): QueueItemRef[] {
  const used = new Set<number>();
  const picked: QueueItemRef[] = [];
  positions.i.forEach((index, k) => {
    const id = positions.id[k];
    let at = items[index]?.trackId === id && !used.has(index) ? index : -1;
    if (at < 0) at = items.findIndex((r, n) => r.trackId === id && !used.has(n));
    if (at < 0) return;
    used.add(at);
    picked.push(items[at]);
  });
  return picked;
}

/** The positions still hold exactly the tracks the remote saw (a move is only safe then). */
export function positionsStillMatch(items: readonly QueueItemRef[], positions: QueuePositions): boolean {
  return positions.i.every((index, k) => items[index]?.trackId === positions.id[k]);
}

export type QueueAddMode = 'end' | 'next' | 'at';

export interface QueueAdd {
  mode: QueueAddMode;
  at: number;
  ids: string[];
}

interface PendingAdd {
  mode: QueueAddMode;
  at: number;
  parts: (string[] | undefined)[];
  timer: ReturnType<typeof setTimeout>;
}

/** Parts of an add that never complete are dropped after this long. */
const ADD_TIMEOUT_MS = 15_000;
const MAX_PARTS = 200;

/** Puts the parts of each add back together; `take` returns the whole add once its last part is in. */
export function createAddCollector() {
  const pending = new Map<string, PendingAdd>();
  return {
    take(args: Record<string, unknown> | null): QueueAdd | null {
      const batch = args?.batch;
      const part = args?.part;
      const parts = args?.parts;
      const mode = args?.mode;
      const ids = args?.ids;
      if (typeof batch !== 'string' || !batch || batch.length > 40) return null;
      if (!Number.isInteger(parts) || (parts as number) < 1 || (parts as number) > MAX_PARTS) return null;
      if (!Number.isInteger(part) || (part as number) < 0 || (part as number) >= (parts as number)) return null;
      if (mode !== 'end' && mode !== 'next' && mode !== 'at') return null;
      if (!Array.isArray(ids) || !ids.every(s => typeof s === 'string')) return null;
      const at = Number.isInteger(args?.at) && (args?.at as number) >= 0 ? (args?.at as number) : 0;

      let entry = pending.get(batch);
      if (!entry) {
        entry = {
          mode, at,
          parts: new Array<string[] | undefined>(parts as number).fill(undefined),
          timer: setTimeout(() => pending.delete(batch), ADD_TIMEOUT_MS),
        };
        pending.set(batch, entry);
      }
      if (entry.parts.length !== parts) return null;
      entry.parts[part as number] = ids as string[];
      if (entry.parts.some(p => p === undefined)) return null;
      clearTimeout(entry.timer);
      pending.delete(batch);
      return { mode: entry.mode, at: entry.at, ids: entry.parts.flat() as string[] };
    },
    clear() {
      for (const e of pending.values()) clearTimeout(e.timer);
      pending.clear();
    },
  };
}

/** Sorted positions as runs `[start, count]`: a selection of hundreds of tracks fits one command. */
export function toRuns(indices: readonly number[]): [number, number][] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[0] + last[1] === i) last[1]++;
    else runs.push([i, 1]);
  }
  return runs;
}

/** Positions from runs `[start, count]`; null when malformed or implausibly large. */
export function fromRuns(raw: unknown, max = 100_000): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (const run of raw) {
    if (!Array.isArray(run) || run.length !== 2) return null;
    const [start, count] = run;
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1) return null;
    if (out.length + count > max) return null;
    for (let k = 0; k < count; k++) out.push(start + k);
  }
  return out;
}
