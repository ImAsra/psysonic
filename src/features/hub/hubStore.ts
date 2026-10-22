import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  remoteState: HubRemoteState | null;
  /** Local receive time of remoteState (ms), used to extrapolate position. */
  remoteStateAt: number;
  setRuntime: (p: Partial<Pick<HubStore, 'status' | 'devices' | 'remoteState' | 'remoteStateAt'>>) => void;
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
      remoteState: null,
      remoteStateAt: 0,
      setRuntime: p => set(p),
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
