import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useHubRemote } from './useHubRemote';

/**
 * "What should this screen show?" hooks. While another device is the active player
 * (hub), they return that device's values; otherwise the local player's.
 * Use these for DISPLAY in any player UI (fullscreen player, mini player, ...).
 * Actions need no change: the hub client already routes them to the active device.
 */
export function useViewTrack() {
  const remote = useHubRemote();
  const local = usePlayerStore(s => s.currentTrack);
  return remote?.track ?? local;
}

export function useViewPlaying() {
  const remote = useHubRemote();
  const local = usePlayerStore(s => s.isPlaying);
  return remote ? remote.state.playing === true : local;
}

export function useViewVolume() {
  const remote = useHubRemote();
  const local = usePlayerStore(s => s.volume);
  return remote && typeof remote.state.volume === 'number' ? remote.state.volume : local;
}

export function useViewRepeat() {
  const remote = useHubRemote();
  const local = usePlayerStore(s => s.repeatMode);
  return remote?.state.repeat ?? local;
}

export function useViewShuffle() {
  const remote = useHubRemote();
  const local = usePlayerStore(s => s.shuffleMode);
  return remote?.state.shuffle ?? local;
}
