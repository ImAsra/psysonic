import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HUB_ARGS_BUDGET,
  chunkIds,
  chunkPositions,
  createAddCollector,
  pickQueueRefs,
  positionsStillMatch,
  readPositions,
} from './hubQueueEdits';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `track-id-${String(i).padStart(6, '0')}`);
const refs = (...trackIds: string[]) => trackIds.map(trackId => ({ serverId: 'srv', trackId }));

describe('chunkIds', () => {
  it('keeps a short list in one part', () => {
    expect(chunkIds(['a', 'b'], { mode: 'end' })).toEqual([['a', 'b']]);
  });

  it('splits a long list so every part fits the hub and nothing is lost', () => {
    const all = ids(500);
    const base = { batch: 'b-1', part: 999, parts: 999, mode: 'end', at: 0 };
    const parts = chunkIds(all, base);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toEqual(all);
    for (const part of parts) expect(JSON.stringify({ ...base, ids: part }).length).toBeLessThanOrEqual(HUB_ARGS_BUDGET);
  });
});

describe('chunkPositions', () => {
  it('splits many positions into parts that fit', () => {
    const positions = ids(300).map((id, i) => ({ i, id }));
    const parts = chunkPositions(positions);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap(p => p.id)).toEqual(positions.map(p => p.id));
    for (const part of parts) expect(JSON.stringify(part).length).toBeLessThanOrEqual(HUB_ARGS_BUDGET);
  });
});

describe('readPositions', () => {
  it('rejects malformed arguments', () => {
    expect(readPositions(null)).toBeNull();
    expect(readPositions({ i: [0, 1], id: ['a'] })).toBeNull();
    expect(readPositions({ i: [-1], id: ['a'] })).toBeNull();
    expect(readPositions({ i: [0], id: [1] })).toBeNull();
    expect(readPositions({ i: [2], id: ['a'] })).toEqual({ i: [2], id: ['a'] });
  });
});

describe('pickQueueRefs', () => {
  it('takes the position when it still holds the track', () => {
    const items = refs('a', 'b', 'a');
    expect(pickQueueRefs(items, { i: [2], id: ['a'] })).toEqual([items[2]]);
  });

  it('finds a track that moved and skips one that is gone', () => {
    const items = refs('x', 'b', 'c');
    expect(pickQueueRefs(items, { i: [0, 1], id: ['c', 'gone'] })).toEqual([items[2]]);
  });

  it('never picks the same entry twice', () => {
    const items = refs('a', 'a');
    expect(pickQueueRefs(items, { i: [0, 0], id: ['a', 'a'] })).toEqual([items[0], items[1]]);
  });
});

describe('positionsStillMatch', () => {
  it('is false once a position holds another track', () => {
    const items = refs('a', 'b');
    expect(positionsStillMatch(items, { i: [0, 1], id: ['a', 'b'] })).toBe(true);
    expect(positionsStillMatch(items, { i: [0], id: ['b'] })).toBe(false);
  });
});

describe('createAddCollector', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the add once all parts are in, in part order', () => {
    const c = createAddCollector();
    expect(c.take({ batch: 'b', part: 1, parts: 2, mode: 'at', at: 3, ids: ['c'] })).toBeNull();
    expect(c.take({ batch: 'b', part: 0, parts: 2, mode: 'at', at: 3, ids: ['a', 'b'] }))
      .toEqual({ mode: 'at', at: 3, ids: ['a', 'b', 'c'] });
  });

  it('ignores malformed parts', () => {
    const c = createAddCollector();
    expect(c.take({ batch: 'b', part: 0, parts: 1, mode: 'sideways', ids: ['a'] })).toBeNull();
    expect(c.take({ batch: 'b', part: 1, parts: 1, mode: 'end', ids: ['a'] })).toBeNull();
    expect(c.take({ batch: '', part: 0, parts: 1, mode: 'end', ids: ['a'] })).toBeNull();
  });

  it('drops an add whose remaining parts never come', () => {
    vi.useFakeTimers();
    const c = createAddCollector();
    c.take({ batch: 'b', part: 0, parts: 2, mode: 'end', ids: ['a'] });
    vi.advanceTimersByTime(20_000);
    // The late part starts a new, incomplete add instead of completing the old one.
    expect(c.take({ batch: 'b', part: 1, parts: 2, mode: 'end', ids: ['b'] })).toBeNull();
  });
});
