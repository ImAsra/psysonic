import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';

const { getPlayQueueMock, savePlayQueueMock } = vi.hoisted(() => ({
  getPlayQueueMock: vi.fn(),
  savePlayQueueMock: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('./hubServerKeys', () => ({ currentServerKeys: () => Promise.resolve(['key']) }));
vi.mock('@/lib/api/subsonicPlayQueue', () => ({
  getPlayQueueForServer: getPlayQueueMock,
  savePlayQueue: savePlayQueueMock,
}));
// Loading the paused engine after a queue change is outside these queue assertions.
vi.mock('@/features/playback/store/pausedRestorePrepare', () => ({ preparePausedRestoreOnStartup: vi.fn() }));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({ isSubsonicServerReachable: () => true }));
vi.mock('@/features/playback/utils/playback/playbackServer', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlaybackServerId: () => 'srv',
  playbackProfileIdForTrack: () => 'srv',
  filterQueueRefsForPlaybackServer: <T>(refs: T[]) => refs,
}));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePlayQueueSyncSettingsStore } from '@/features/playback/store/playQueueSyncSettingsStore';
import { flushQueueSyncToServer } from '@/features/playback/store/queueSync';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { rejoinHub, startHubClient } from './hubClient';
import { useHubStore } from './hubStore';

/** A socket the test drives by hand; every instance is kept so reconnects can be seen. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1];
const flush = () => new Promise(r => setTimeout(r, 0));
const living = { id: 'living', name: 'Living room', kind: 'desktop', active: true };
const me = { id: 'desk-me', name: 'Desk', kind: 'desktop', active: false };
const song = (id: string) => ({ id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 });
const track = (id: string): Track => ({ ...song(id), serverId: 'srv' });
const queueIds = () => usePlayerStore.getState().queueItems.map(r => r.trackId);

/** A pending answer to getPlayQueue that the test resolves when it wants. */
function deferredQueue() {
  let resolve!: (v: unknown) => void;
  getPlayQueueMock.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  return (ids: string[]) => resolve({ songs: ids.map(song), current: ids[0], position: 0 });
}

describe('hub client and the shared queue', () => {
  let stop: () => void;

  beforeEach(() => {
    resetAllStores();
    FakeSocket.all = [];
    getPlayQueueMock.mockReset();
    getPlayQueueMock.mockResolvedValue({ songs: [] });
    savePlayQueueMock.mockClear();
    vi.stubGlobal('WebSocket', FakeSocket);
    usePlayQueueSyncSettingsStore.setState({ enabled: true });
    useAuthStore.setState({ activeServerId: 'srv' });
    usePlayerStore.setState({
      queueItems: [{ serverId: 'srv', trackId: 'mine' }],
      queueIndex: 0,
      currentTrack: track('mine'),
      isPlaying: false,
    });
    useHubStore.setState({ enabled: true, url: 'http://hub.local:5533', token: 'tok', deviceId: 'desk-me', joined: false });
    stop = startHubClient();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it('on its own, this device never saves its queue to the music server', async () => {
    await flushQueueSyncToServer(usePlayerStore.getState().queueItems, track('mine'), 12);

    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });

  it('with the hub switched off altogether, the queue saves as usual', async () => {
    useHubStore.setState({ enabled: false });
    await flushQueueSyncToServer(usePlayerStore.getState().queueItems, track('mine'), 12);

    expect(savePlayQueueMock).toHaveBeenCalled();
  });

  it('joining to control another player takes the shared queue before any edit is pushed', async () => {
    FakeSocket.all[0].open();
    const answer = deferredQueue();
    rejoinHub('join');
    latest().open();
    await flush();
    latest().receive({ t: 'welcome', devices: [living, me], state: { from: 'living', trackId: 'shared1', playing: true } });

    // An edit while the shared queue is still loading must not reach the server.
    usePlayerStore.setState({ queueItems: [{ serverId: 'srv', trackId: 'mine' }, { serverId: 'srv', trackId: 'extra' }] });
    await new Promise(r => setTimeout(r, 500));
    expect(savePlayQueueMock).not.toHaveBeenCalled();

    answer(['shared1', 'shared2']);
    await new Promise(r => setTimeout(r, 50));
    expect(queueIds()).toEqual(['shared1', 'shared2']);
    for (const call of savePlayQueueMock.mock.calls) expect(call[0]).toEqual(['shared1', 'shared2']);
  });

  it('a queue refresh that answers after hub control is switched off is ignored', async () => {
    useHubStore.setState({ joined: true });
    latest().open();
    await flush();
    latest().receive({ t: 'welcome', devices: [{ ...me, active: true }] });
    const answer = deferredQueue();
    latest().receive({ t: 'queue-changed' });

    useHubStore.getState().setJoined(false);
    answer(['shared1', 'shared2']);
    await flush();

    expect(queueIds()).toEqual(['mine']);
  });

  it('a joined hello never goes out on the watcher connection that replaced it', async () => {
    useHubStore.setState({ joined: true });
    const joinedSock = latest();
    joinedSock.open(); // its hello waits for the server keys
    useHubStore.getState().setJoined(false);
    const watcher = latest();
    watcher.open();
    await flush();

    expect(watcher.sent).toEqual([expect.objectContaining({ t: 'hello', kind: 'web' })]);
  });
});
