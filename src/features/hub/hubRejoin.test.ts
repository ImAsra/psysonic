import { beforeEach, describe, expect, it } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { useHubStore, type HubDevice } from './hubStore';
import { rejoinConflict } from './hubRejoin';
import { rejoinHub } from './hubClient';
import { selectHubRemote } from './useHubRemote';

const living: HubDevice = { id: 'living', name: 'Living room', kind: 'desktop', active: true };
const phone: HubDevice = { id: 'page', name: 'Phone', kind: 'web', active: false };
const playingThere = { from: 'living', ts: 0, title: 'Song', playing: true };

describe('rejoining the hub', () => {
  beforeEach(() => resetAllStores());

  it('asks only when this device and the hub\'s player are both playing', () => {
    const away = { joined: false, devices: [living, phone], remoteState: playingThere };
    expect(rejoinConflict(away, true)).toEqual(living);
    expect(rejoinConflict(away, false)).toBeNull();
    expect(rejoinConflict({ ...away, remoteState: { ...playingThere, playing: false } }, true)).toBeNull();
    expect(rejoinConflict({ ...away, devices: [{ ...living, active: false }] }, true)).toBeNull();
    expect(rejoinConflict({ ...away, joined: true }, true)).toBeNull();
  });

  it('"Join" stops the music here before rejoining; "Play here" keeps it playing', () => {
    useHubStore.setState({ joined: false });
    usePlayerStore.setState({ isPlaying: true });
    let paused = 0;
    usePlayerStore.setState({ pause: () => { paused++; usePlayerStore.setState({ isPlaying: false }); } });

    rejoinHub('playHere');
    expect(useHubStore.getState().joined).toBe(true);
    expect(paused).toBe(0);

    useHubStore.setState({ joined: false });
    rejoinHub('join');
    expect(useHubStore.getState().joined).toBe(true);
    expect(paused).toBe(1);
  });

  it('a device on its own never mirrors the playing one', () => {
    const snap = { status: 'connected', joined: true, devices: [living], deviceId: 'me', remoteState: playingThere, remoteStateAt: 0 };
    expect(selectHubRemote(snap)?.device.id).toBe('living');
    expect(selectHubRemote({ ...snap, joined: false })).toBeNull();
  });
});
