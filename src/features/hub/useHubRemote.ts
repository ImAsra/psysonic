import { useMemo } from 'react';
import type { Track } from '@/lib/media/trackTypes';
import { useHubStore } from './hubStore';
import type { HubDevice, HubRemoteState } from './hubStore';

export interface HubRemote {
  device: HubDevice;
  state: HubRemoteState;
  stateAt: number;
}

type Snap = {
  status: string;
  devices: HubDevice[];
  deviceId: string;
  remoteState: HubRemoteState | null;
  remoteStateAt: number;
};

/** Non-null while ANOTHER device is the active player (Spotify Connect style). */
export function selectHubRemote(s: Snap): HubRemote | null {
  if (s.status !== 'connected') return null;
  const device = s.devices.find(d => d.active && d.id !== s.deviceId && d.kind !== 'web');
  if (!device || !s.remoteState || s.remoteState.from !== device.id) return null;
  return { device, state: s.remoteState, stateAt: s.remoteStateAt };
}

export const getHubRemote = () => selectHubRemote(useHubStore.getState());

/** Position of the remote track right now, extrapolated while it is playing. */
export function remotePosition(state: HubRemoteState, stateAt: number, now = Date.now()): number {
  const base = (state.positionSec ?? 0) + (state.playing ? (now - stateAt) / 1000 : 0);
  const dur = state.durationSec ?? 0;
  return Math.max(0, dur > 0 ? Math.min(dur, base) : base);
}

/**
 * Remote mode for the REAL player bar: while another device plays, the bar
 * keeps its normal layout and shows `track` / `state` instead of the local player.
 */
export function useHubRemote() {
  const status = useHubStore(s => s.status);
  const devices = useHubStore(s => s.devices);
  const deviceId = useHubStore(s => s.deviceId);
  const remoteState = useHubStore(s => s.remoteState);
  const remoteStateAt = useHubStore(s => s.remoteStateAt);
  const remote = selectHubRemote({ status, devices, deviceId, remoteState, remoteStateAt });

  const st = remote?.state;
  const track = useMemo<Track | null>(
    () => st?.trackId
      ? {
          id: st.trackId,
          title: st.title ?? '',
          artist: st.artist ?? '',
          album: st.album ?? '',
          albumId: st.albumId ?? '',
          artistId: st.artistId,
          duration: st.durationSec ?? 0,
          coverArt: st.coverArt,
        }
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [st?.trackId, st?.title, st?.artist, st?.album, st?.albumId, st?.artistId, st?.durationSec, st?.coverArt],
  );

  return remote ? { ...remote, track } : null;
}
