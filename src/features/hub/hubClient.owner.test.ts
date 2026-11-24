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
vi.mock('@/features/playback/store/pausedRestorePrepare', () => ({ preparePausedRestoreOnStartup: vi.fn() }));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({ isSubsonicServerReachable: () => true }));
vi.mock('@/features/playback/utils/playback/playbackServer', async importOriginal => ({
  ...(await importOriginal<object>()),
  getPlaybackServerId: () => 'srv',
  playbackProfileIdForTrack: () => 'srv',
  filterQueueRefsForPlaybackServer: <T>(refs: T[]) => refs,
}));
// The player looks the requested tracks up in its library; here every id is known except "unknown".
vi.mock('@/features/playback/store/queueTrackResolver', async importOriginal => ({
  ...(await importOriginal<object>()),
  resolveBatch: vi.fn(async () => undefined),
  getCachedTrack: (ref: { trackId: string }) =>
    ref.trackId === 'unknown'
      ? undefined
      : { id: ref.trackId, title: ref.trackId, artist: 'A', album: 'X', albumId: 'X', duration: 100, serverId: 'srv' },
}));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePlayQueueSyncSettingsStore } from '@/features/playback/store/playQueueSyncSettingsStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { startHubClient } from './hubClient';
import { useHubStore } from './hubStore';

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
const song = (id: string) => ({ id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 });
const track = (id: string): Track => ({ ...song(id), serverId: 'srv' });
const queueIds = () => usePlayerStore.getState().queueItems.map(r => r.trackId);
const commands = () => latest().sent.filter(m => m.t === 'command');
const signals = () => latest().sent.filter(m => m.t === 'queue-changed').length;

async function connect(devices: unknown[], state: unknown) {
  useHubStore.setState({ enabled: true, url: 'http://hub.local:5533', token: 'tok', deviceId: 'desk-me', joined: true });
  const stop = startHubClient();
  latest().open();
  await flush();
  latest().receive({ t: 'welcome', devices, state });
  await vi.advanceTimersByTimeAsync(5_000);
  savePlayQueueMock.mockClear();
  latest().sent.length = 0;
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAllStores();
  FakeSocket.all = [];
  getPlayQueueMock.mockReset();
  savePlayQueueMock.mockClear();
  vi.stubGlobal('WebSocket', FakeSocket);
  usePlayQueueSyncSettingsStore.setState({ enabled: true });
  useAuthStore.setState({ activeServerId: 'srv' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hub client: a remote sends its queue edits to the player', () => {
  let stop: () => void;
  const living = { id: 'living', name: 'Living room', kind: 'desktop', active: true };
  const me = { id: 'desk-me', name: 'Desk', kind: 'desktop', active: false };

  beforeEach(async () => {
    getPlayQueueMock.mockResolvedValue({ songs: ['a', 'b', 'c'].map(song), current: 'a', position: 0 });
    usePlayerStore.setState({ queueItems: [{ serverId: 'srv', trackId: 'a' }], queueIndex: 0, currentTrack: track('a'), isPlaying: false });
    stop = await connect([living, me], { from: 'living', trackId: 'a', playing: true });
    expect(queueIds()).toEqual(['a', 'b', 'c']); // caught up with the shared queue
  });
  afterEach(() => stop());

  it('adding tracks sends them to the player and saves nothing here', async () => {
    usePlayerStore.getState().enqueue([track('d'), track('e')]);
    usePlayerStore.getState().playNext([track('f')]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(commands().map(m => [m.to, m.action, (m.args as { mode: string; ids: string[] }).mode, (m.args as { ids: string[] }).ids]))
      .toEqual([['living', 'queueAdd', 'end', ['d', 'e']], ['living', 'queueAdd', 'next', ['f']]]);
    expect(queueIds()).toEqual(['a', 'b', 'c']);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
    expect(signals()).toBe(0);
  });

  it('a move shows here at once, goes to the player, and is not saved here', async () => {
    usePlayerStore.getState().reorderQueue(2, 1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(queueIds()).toEqual(['a', 'c', 'b']);
    expect(commands()).toEqual([expect.objectContaining({ action: 'moveQueue', args: { from: 2, to: 1, trackId: 'c' } })]);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
    expect(signals()).toBe(0);
  });

  it('removing, clearing and undo go to the player as well', async () => {
    usePlayerStore.getState().removeTrack(1);
    usePlayerStore.getState().clearQueueExceptCurrent();
    usePlayerStore.getState().undoLastQueueEdit();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(commands().map(m => [m.action, m.args])).toEqual([
      ['removeQueue', { i: [1], id: ['b'] }],
      ['clearQueueExceptCurrent', null],
      ['undoQueue', null],
    ]);
    expect(savePlayQueueMock).not.toHaveBeenCalled();
  });
});

describe('hub client: the player applies queue edits from remotes and saves them', () => {
  let stop: () => void;
  const phone = { id: 'phone', name: 'Phone', kind: 'mobile', active: false };
  const me = { id: 'desk-me', name: 'Desk', kind: 'desktop', active: true };

  beforeEach(async () => {
    getPlayQueueMock.mockResolvedValue({ songs: [] });
    usePlayerStore.setState({
      queueItems: ['a', 'b', 'c'].map(trackId => ({ serverId: 'srv', trackId })),
      queueIndex: 0,
      currentTrack: track('a'),
      isPlaying: false,
    });
    stop = await connect([phone, me], { from: 'desk-me', trackId: 'a', playing: false });
  });
  afterEach(() => stop());

  const lastSaved = () => savePlayQueueMock.mock.calls[savePlayQueueMock.mock.calls.length - 1]?.[0];

  it('an add in two parts lands once both are in, then is saved and signalled', async () => {
    latest().receive({ t: 'command', from: 'phone', action: 'queueAdd', args: { batch: 'x', part: 1, parts: 2, mode: 'end', at: 0, ids: ['f'] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueIds()).toEqual(['a', 'b', 'c']);

    latest().receive({ t: 'command', from: 'phone', action: 'queueAdd', args: { batch: 'x', part: 0, parts: 2, mode: 'end', at: 0, ids: ['d', 'unknown', 'e'] } });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(queueIds()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(lastSaved()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(signals()).toBeGreaterThan(0);
  });

  it('a removal finds its track even after the queue moved, and a stale move is dropped', async () => {
    latest().receive({ t: 'command', from: 'phone', action: 'removeQueue', args: { i: [0], id: ['c'] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueIds()).toEqual(['a', 'b']);

    latest().receive({ t: 'command', from: 'phone', action: 'moveQueueItems', args: { i: [1], id: ['c'], gap: 0 } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queueIds()).toEqual(['a', 'b']);
    expect(lastSaved()).toEqual(['a', 'b']);
  });
});
