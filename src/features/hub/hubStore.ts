import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Track } from '@/lib/media/trackTypes';

export type HubStatus =
  | 'off'
  | 'connecting'
  | 'connected'
  | 'unauthorized'
  | 'incompatible'
  | 'error';

export interface HubDevice {
  id: string;
  name: string;
  kind: 'desktop' | 'phone' | 'web';
  active: boolean;
  /** Hashes of the music server + account this device uses (see hubServerKeys.ts). */
  server?: string[];
}

/** Playback state as reported by another device through the hub. */
export interface HubRemoteState {
  from: string;
  ts: number;
  trackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  durationSec?: number;
  positionSec?: number;
  playing?: boolean;
  volume?: number;
  shuffle?: boolean;
  repeat?: 'off' | 'all' | 'one';
}

/** Build a Track-like object from what another device reported. */
export function trackFromRemoteState(st: HubRemoteState): Track | null {
  if (!st.trackId) return null;
  return {
    id: st.trackId,
    title: st.title ?? '',
    artist: st.artist ?? '',
    album: st.album ?? '',
    albumId: st.albumId ?? '',
    artistId: st.artistId,
    duration: st.durationSec ?? 0,
    coverArt: st.coverArt,
  };
}

interface HubStore {
  // persisted settings
  enabled: boolean;
  url: string;
  token: string;
  deviceId: string;
  deviceName: string;
  setEnabled: (v: boolean) => void;
  setUrl: (v: string) => void;
  setToken: (v: string) => void;
  setDeviceName: (v: string) => void;
  /** Keep crossfade / AutoDJ / gapless etc. identical on all devices. */
  syncPlaybackSettings: boolean;
  setSyncPlaybackSettings: (v: boolean) => void;
  // runtime only (not persisted)
  status: HubStatus;
  devices: HubDevice[];
  /** The hub refuses handoffs between different music servers/accounts (HUB_SERVER_CHECK). */
  serverCheck: boolean;
  remoteState: HubRemoteState | null;
  /** Local receive time of remoteState (ms), used to extrapolate position. */
  remoteStateAt: number;
  /** remoteState as a Track; keeps its identity while the track itself is unchanged. */
  remoteTrack: Track | null;
  setRuntime: (p: Partial<Pick<HubStore, 'status' | 'devices' | 'serverCheck' | 'remoteState' | 'remoteStateAt'>>) => void;
}

const newDeviceId = () =>
  `desk-${(globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)).slice(0, 12)}`;

export const useHubStore = create<HubStore>()(
  persist(
    set => ({
      enabled: false,
      url: '',
      token: '',
      deviceId: newDeviceId(),
      deviceName: 'Psysonic Desktop',
      syncPlaybackSettings: true,
      setEnabled: enabled => set({ enabled }),
      setUrl: url => set({ url }),
      setToken: token => set({ token }),
      setDeviceName: deviceName => set({ deviceName }),
      setSyncPlaybackSettings: syncPlaybackSettings => set({ syncPlaybackSettings }),
      status: 'off',
      devices: [],
      serverCheck: true,
      remoteState: null,
      remoteStateAt: 0,
      remoteTrack: null,
      setRuntime: p => set(s => {
        if (!('remoteState' in p)) return p;
        const t = p.remoteState ? trackFromRemoteState(p.remoteState) : null;
        const same = !!s.remoteTrack && !!t && JSON.stringify(s.remoteTrack) === JSON.stringify(t);
        return { ...p, remoteTrack: same ? s.remoteTrack : t };
      }),
    }),
    {
      name: 'psysonic_hub_settings',
      partialize: s => ({
        enabled: s.enabled,
        url: s.url,
        token: s.token,
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        syncPlaybackSettings: s.syncPlaybackSettings,
      }),
    },
  ),
);
