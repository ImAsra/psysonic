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
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { startHubClient } from './hubClient';
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
const flush = () => vi.advanceTimersByTimeAsync(0);
const living = { id: 'living', name: 'Living room', kind: 'desktop', active: true };
const me = { id: 'desk-me', name: 'Desk', kind: 'desktop', active: false };
const song = (id: string) => ({ id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 });
const track = (id: string): Track => ({ ...song(id), serverId: 'srv' });
const queueIds = () => usePlayerStore.getState().queueItems.map(r => r.trackId);
describe('hub client: a queue taken from the server is not echoed back', () => {
  let stop: () => void;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetAllStores();
    FakeSocket.all = [];
    getPlayQueueMock.mockReset();
    getPlayQueueMock.mockResolvedValue({ songs: [song('shared1'), song('shared2')], current: 'shared1', position: 0 });
    savePlayQueueMock.mockClear();
    vi.stubGlobal('WebSocket', FakeSocket);
    usePlayQueueSyncSettingsStore.setState({ enabled: true });
    useAuthStore.setState({ activeServerId: 'srv' });
    usePlayerStore.setState({
      queueItems: [{ serverId: 'srv', trackId: 'shared1' }],
      queueIndex: 0,
      currentTrack: track('shared1'),
      isPlaying: false,
    });
    useHubStore.setState({ enabled: true, url: 'http://hub.local:5533', token: 'tok', deviceId: 'desk-me', joined: true });
    stop = startHubClient();
    latest().open();
    await flush();
    latest().receive({ t: 'welcome', devices: [living, me], state: { from: 'living', trackId: 'shared1', playing: true } });
    await vi.advanceTimersByTimeAsync(5_000); // initial catch-up done
    savePlayQueueMock.mockClear();
    latest().sent.length = 0;
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const signals = () => latest().sent.filter(m => m.t === 'queue-changed').length;

  it('takes a changed queue without saving it again or signalling', async () => {
    getPlayQueueMock.mockResolvedValue({ songs: [song('shared1'), song('shared2'), song('shared3')], current: 'shared1', position: 30_000 });
    latest().receive({ t: 'queue-changed' });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(queueIds()).toEqual(['shared1', 'shared2', 'shared3']);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
    expect(signals()).toBe(0);
  });

  it('a queue that only moved on in time is not applied again', async () => {
    // The playing device saves a later position each time; the tracks are the same.
    for (const position of [10_000, 20_000, 30_000]) {
      getPlayQueueMock.mockResolvedValue({ songs: [song('shared1'), song('shared2')], current: 'shared1', position });
      const before = usePlayerStore.getState().queueItems;
      latest().receive({ t: 'queue-changed' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(usePlayerStore.getState().queueItems).toBe(before);
    }
    expect(savePlayQueueMock).not.toHaveBeenCalled();
    expect(signals()).toBe(0);
  });
});
