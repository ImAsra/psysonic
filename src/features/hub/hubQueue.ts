import type { Track } from '@/lib/media/trackTypes';

/** How many tracks before the current one a remote sees (the rest of the window is upcoming). */
export const HUB_QUEUE_BEFORE = 20;
/** The hub keeps at most this many tracks per queue window. */
export const HUB_QUEUE_MAX = 300;

export interface HubQueueTrack {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  durationSec?: number;
}

/** A window of the queue: `tracks` start at absolute position `offset`; `index` is the current track. */
export interface HubQueue {
  index: number;
  offset: number;
  total: number;
  tracks: HubQueueTrack[];
}

/**
 * The part of the queue a remote shows: a few tracks before the current one and as many
 * upcoming ones as fit. Positions stay absolute, so a remote can ask for "play position N".
 */
export function hubQueueWindow(tracks: Track[], index: number): HubQueue {
  const total = tracks.length;
  const current = total === 0 ? -1 : Math.min(Math.max(0, index), total - 1);
  const offset = Math.max(0, Math.min(current - HUB_QUEUE_BEFORE, total - HUB_QUEUE_MAX));
  return {
    index: current,
    offset,
    total,
    tracks: tracks.slice(offset, offset + HUB_QUEUE_MAX).map(t => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumId: t.albumId,
      artistId: t.artistId,
      coverArt: t.coverArt,
      durationSec: t.duration,
    })),
  };
}

/**
 * The queue position a remote asked to play, or -1 when the queue has changed since the remote
 * saw it (the track at that position is no longer the one it showed).
 */
export function resolveQueuePlayIndex(tracks: Pick<Track, 'id'>[], index: unknown, trackId: unknown): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= tracks.length) return -1;
  if (typeof trackId === 'string' && tracks[index].id !== trackId) return -1;
  return index;
}

/**
 * The move a remote asked for (track at `from` ends up at `to`), or null when the queue has changed
 * since the remote saw it, the target is outside the queue, or nothing would move.
 */
export function resolveQueueMove(
  tracks: Pick<Track, 'id'>[],
  from: unknown,
  to: unknown,
  trackId: unknown,
): { from: number; to: number } | null {
  const src = resolveQueuePlayIndex(tracks, from, trackId);
  if (src < 0 || typeof to !== 'number' || !Number.isInteger(to) || to < 0 || to >= tracks.length) return null;
  return src === to ? null : { from: src, to };
}
