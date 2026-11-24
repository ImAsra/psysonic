import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';

const { getPlayQueueMock } = vi.hoisted(() => ({ getPlayQueueMock: vi.fn() }));

vi.mock('./hubServerKeys', () => ({ currentServerKeys: () => Promise.resolve(['key']) }));
vi.mock('@/lib/api/subsonicPlayQueue', () => ({
  getPlayQueueForServer: getPlayQueueMock,
  savePlayQueue: vi.fn(async () => undefined),
}));
// Loading the paused engine after a queue change is outside these assertions.
vi.mock('@/features/playback/store/pausedRestorePrepare', () => ({ preparePausedRestoreOnStartup: vi.fn() }));
vi.mock('@/lib/network/subsonicNetworkGuard', () => ({ isSubsonicServerReachable: () => true }));

import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePlayQueueSyncSettingsStore } from '@/features/playback/store/playQueueSyncSettingsStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { startHubClient } from './hubClient';
import { useHubStore } from './hubStore';
import { preparePausedRestoreOnStartup } from '@/features/playback/store/pausedRestorePrepare';
import { emitPlaybackProgress } from '@/features/playback/store/playbackProgress';

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
const desk = { id: 'desk', name: 'Desk', kind: 'desktop', active: true };
const me = { id: 'phone-me', name: 'Phone', kind: 'phone', active: false };
const song = (id: string) => ({ id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 });
const track = (id: string, serverId: string): Track => ({ ...song(id), serverId });
const current = () => {
  const s = usePlayerStore.getState();
  return { slot: s.queueItems[s.queueIndex], track: s.currentTrack?.id };
};

describe('hub takeover on a device whose queue still holds another server', () => {
  let stop: () => void;
  const resume = vi.fn();
  const seek = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    resetAllStores();
    FakeSocket.all = [];
    resume.mockClear();
    seek.mockClear();
    getPlayQueueMock.mockReset();
    getPlayQueueMock.mockResolvedValue({ songs: [song('down'), song('later')], current: 'down', position: 0 });
    vi.stubGlobal('WebSocket', FakeSocket);
    usePlayQueueSyncSettingsStore.setState({ enabled: true });
    useAuthStore.setState({ activeServerId: 'srv' });
    // Left over from a server this device no longer uses: it is the current entry.
    usePlayerStore.setState({
      queueItems: [{ serverId: 'gone', trackId: 'old' }],
      queueIndex: 0,
      currentTrack: track('old', 'gone'),
      isPlaying: false,
      resume,
      seek,
    });
    useHubStore.setState({ enabled: true, url: 'http://hub.local:5533', token: 'tok', deviceId: 'phone-me', joined: true });
    stop = startHubClient();
    latest().open();
    await flush();
    latest().receive({ t: 'welcome', devices: [desk, me], state: { from: 'desk', trackId: 'down', playing: true } });
    await flush();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('plays the handed-over track, not the leftover one', async () => {
    latest().receive({
      t: 'takeover', from: 'desk', fresh: false, ageMs: 0, server: [],
      state: { from: 'desk', trackId: 'down', positionSec: 0, playing: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(current().track).toBe('down');
    expect(current().slot).toMatchObject({ serverId: 'srv', trackId: 'down' });
    expect(resume).toHaveBeenCalled();
  });

  it('loads the engine at the position the hub reported, not the older saved one', async () => {
    vi.mocked(preparePausedRestoreOnStartup).mockClear();
    // The music server has the position last saved (0:00); the hub knows the player was at 0:40.
    latest().receive({
      t: 'takeover', from: 'desk', fresh: false, ageMs: 0, server: [],
      state: { from: 'desk', trackId: 'down', positionSec: 40, playing: false },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // Already the pull loads it there, so playback never starts at the older position first.
    const calls = vi.mocked(preparePausedRestoreOnStartup).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[3]).toBe(40);
    expect(resume).toHaveBeenCalled();
  });

  it('moves to the hub position once audio runs, when the engine resumed at an older one', async () => {
    resume.mockImplementation(() => usePlayerStore.setState({ isPlaying: true }));
    latest().receive({
      t: 'takeover', from: 'desk', fresh: false, ageMs: 0, server: [],
      state: { from: 'desk', trackId: 'down', positionSec: 40, playing: false },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seek).not.toHaveBeenCalled();

    // The engine had the track loaded at the saved position: audio starts at 0:12.
    emitPlaybackProgress({ currentTime: 12, progress: 0.12, buffered: 1 });
    expect(seek).toHaveBeenCalledWith(0.4);

    seek.mockClear();
    emitPlaybackProgress({ currentTime: 12.5, progress: 0.125, buffered: 1 });
    expect(seek).not.toHaveBeenCalled(); // once only
  });

  it('after a click-to-play handoff, plays the track the music server names', async () => {
    getPlayQueueMock.mockResolvedValue({ songs: [song('down'), song('picked')], current: 'picked', position: 0 });
    latest().receive({
      t: 'takeover', from: 'desk', fresh: true, ageMs: 0, server: [],
      // Fresh: the hub's "now playing" is still the old one, the server queue has the pick.
      state: { from: 'desk', trackId: 'down', positionSec: 40, playing: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(current().track).toBe('picked');
    expect(current().slot).toMatchObject({ serverId: 'srv', trackId: 'picked' });
  });
});
