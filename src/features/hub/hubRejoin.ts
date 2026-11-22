import type { HubDevice, HubRemoteState } from './hubStore';

interface Snap {
  joined: boolean;
  devices: HubDevice[];
  remoteState: HubRemoteState | null;
}

/**
 * The device playing through the hub while this one, on its own, plays too. Rejoining then has to
 * choose (the hub lets one device play), so the switch asks; null when it can simply rejoin.
 */
export function rejoinConflict(s: Snap, playingHere: boolean): HubDevice | null {
  if (s.joined || !playingHere) return null;
  const active = s.devices.find(d => d.active && d.kind !== 'web');
  if (!active || s.remoteState?.from !== active.id || !s.remoteState.playing) return null;
  return active;
}
