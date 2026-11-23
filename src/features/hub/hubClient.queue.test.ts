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
const flush = () => vi.advanceTimersByTimeAsync(0);
const living = { id: 'living', name: 'Living room', kind: 'desktop', active: true };
const me = { id: 'desk-me', name: 'Desk', kind: 'desktop', active: false };
const song = (id: string) => ({ id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 });
const track = (id: string): Track => ({ ...song(id), serverId: 'srv' });
const queueIds = () => usePlayerStore.getState().queueItems.map(r => r.trackId);
/** Every queue the music server was asked to save. */
const savedQueues = () => savePlayQueueMock.mock.calls.map(call => call[0] as string[]);
/** The queue this device kept on its own, or an edit of it, never reaches the server. */
const savedOnlyShared = () => savedQueues().every(ids => !ids.includes('mine') && !ids.includes('extra'));

/** A pending answer to getPlayQueue that the test resolves when it wants. */
function deferredQueue() {
  let resolve!: (v: unknown) => void;
  getPlayQueueMock.mockReturnValueOnce(new Promise(r => { resolve = r; }));
  return (ids: string[]) => resolve({ songs: ids.map(song), current: ids[0], position: 0 });
}

describe('hub client and the shared queue', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
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

  /** Switch hub control back on with "Join" while the living room plays; the welcome starts the catch-up. */
  async function joinLivingRoom() {
    FakeSocket.all[0].open();
    rejoinHub('join');
    latest().open();
    await flush();
    latest().receive({ t: 'welcome', devices: [living, me], state: { from: 'living', trackId: 'shared1', playing: true } });
  }

  it('after joining, a queue edit saves nothing while the shared queue is slow to load', async () => {
    const answer = deferredQueue();
    await joinLivingRoom();

    usePlayerStore.getState().enqueue([track('extra')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savePlayQueueMock).not.toHaveBeenCalled();

    answer(['shared1', 'shared2']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queueIds()).toEqual(['shared1', 'shared2']);
    expect(savedOnlyShared()).toBe(true);
  });

  it('after joining, a failed load keeps queue edits off the server and is tried again', async () => {
    getPlayQueueMock.mockRejectedValueOnce(new Error('offline'));
    await joinLivingRoom();
    await flush();

    usePlayerStore.getState().enqueue([track('extra')]);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
    expect(queueIds()).toEqual(['mine', 'extra']);

    getPlayQueueMock.mockResolvedValueOnce({ songs: [song('shared1'), song('shared2')], current: 'shared1', position: 0 });
    await vi.advanceTimersByTimeAsync(2_000); // the retry
    expect(queueIds()).toEqual(['shared1', 'shared2']);

    // Caught up: edits save as usual again.
    usePlayerStore.getState().enqueue([track('next')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savedQueues()[savedQueues().length - 1]).toEqual(['shared1', 'shared2', 'next']);
    expect(savedOnlyShared()).toBe(true);
  });

  it('joining right after a handoff, before the new player has reported, still takes the shared queue', async () => {
    const answer = deferredQueue();
    FakeSocket.all[0].open();
    rejoinHub('join');
    latest().open();
    await flush();
    // The hub already names the living room as active, but its "now playing" is still the kitchen's.
    latest().receive({ t: 'welcome', devices: [living, me], state: { from: 'kitchen', trackId: 'old', playing: false } });

    usePlayerStore.getState().enqueue([track('extra')]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(savePlayQueueMock).not.toHaveBeenCalled();

    answer(['shared1', 'shared2']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queueIds()).toEqual(['shared1', 'shared2']);
    expect(savedOnlyShared()).toBe(true);
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
