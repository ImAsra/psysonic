import { describe, expect, it } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';
import { HUB_QUEUE_BEFORE, HUB_QUEUE_MAX, hubQueueWindow, resolveQueueMove, resolveQueuePlayIndex } from './hubQueue';

const tracks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Song ${i}`, duration: 100 + i }) as Track);

describe('hubQueueWindow', () => {
  it('an empty queue has no current track', () => {
    expect(hubQueueWindow([], 0)).toEqual({ index: -1, offset: 0, total: 0, tracks: [] });
  });

  it('a short queue is sent whole', () => {
    const q = hubQueueWindow(tracks(5), 2);
    expect(q).toMatchObject({ index: 2, offset: 0, total: 5 });
    expect(q.tracks.map(t => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(q.tracks[2]).toMatchObject({ title: 'Song 2', durationSec: 102 });
  });

  it('a long queue keeps a few played tracks and fills the rest with upcoming ones', () => {
    const q = hubQueueWindow(tracks(1000), 500);
    expect(q.offset).toBe(500 - HUB_QUEUE_BEFORE);
    expect(q.tracks).toHaveLength(HUB_QUEUE_MAX);
    expect(q.tracks[q.index - q.offset].id).toBe('t500');
  });

  it('near the end of a long queue the window still holds as many tracks as allowed', () => {
    const q = hubQueueWindow(tracks(1000), 995);
    expect(q.tracks).toHaveLength(HUB_QUEUE_MAX);
    expect(q.tracks[q.tracks.length - 1].id).toBe('t999');
    expect(q.tracks[q.index - q.offset].id).toBe('t995');
  });

  it('an index past the end points at the last track', () => {
    expect(hubQueueWindow(tracks(3), 9).index).toBe(2);
  });
});

describe('resolveQueuePlayIndex', () => {
  const q = tracks(4);

  it('plays the position the remote picked', () => {
    expect(resolveQueuePlayIndex(q, 2, 't2')).toBe(2);
  });

  it('refuses when the queue changed and another track is now at that position', () => {
    expect(resolveQueuePlayIndex(q, 2, 't3')).toBe(-1);
  });

  it('refuses positions outside the queue and non-integer positions', () => {
    expect(resolveQueuePlayIndex(q, 4, 't4')).toBe(-1);
    expect(resolveQueuePlayIndex(q, -1, undefined)).toBe(-1);
    expect(resolveQueuePlayIndex(q, 1.5, undefined)).toBe(-1);
    expect(resolveQueuePlayIndex(q, '1', undefined)).toBe(-1);
  });
});

describe('resolveQueueMove', () => {
  const q = tracks(4);

  it('moves the track the remote picked to the position it asked for', () => {
    expect(resolveQueueMove(q, 1, 3, 't1')).toEqual({ from: 1, to: 3 });
  });

  it('refuses when the queue changed and another track is now at that position', () => {
    expect(resolveQueueMove(q, 1, 3, 't2')).toBeNull();
  });

  it('refuses targets outside the queue, non-integer targets and no-op moves', () => {
    expect(resolveQueueMove(q, 1, 4, 't1')).toBeNull();
    expect(resolveQueueMove(q, 1, -1, 't1')).toBeNull();
    expect(resolveQueueMove(q, 1, 1.5, 't1')).toBeNull();
    expect(resolveQueueMove(q, 1, 1, 't1')).toBeNull();
  });
});
