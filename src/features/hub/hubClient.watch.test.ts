import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { startHubClient, watcherId } from './hubClient';
import { useHubStore } from './hubStore';

vi.mock('./hubServerKeys', () => ({ currentServerKeys: () => Promise.resolve(['key']) }));

/** A socket the test drives by hand; every instance is kept so reconnects can be seen. */
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
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

const living = { id: 'living', name: 'Living room', kind: 'desktop', active: true };
const flush = () => new Promise(r => setTimeout(r, 0));

describe('hub client off hub control', () => {
  let stop: () => void;

  beforeEach(() => {
    resetAllStores();
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    useHubStore.setState({ enabled: true, url: 'http://hub.local:5533', token: 'tok', deviceId: 'desk-me', joined: false });
    stop = startHubClient();
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  it('watches like a web page under its own id, and shows who plays what', () => {
    const ws = FakeSocket.all[0];
    ws.open();
    expect(ws.sent).toEqual([expect.objectContaining({ t: 'hello', kind: 'web', deviceId: watcherId('desk-me') })]);

    ws.receive({ t: 'welcome', devices: [living], state: { from: 'living', title: 'Song', playing: true } });
    const hub = useHubStore.getState();
    expect(hub.status).toBe('connected');
    expect(hub.devices).toEqual([living]);
    expect(hub.remoteState?.title).toBe('Song');
  });

  it('tells the hub nothing and ignores commands and queue changes', async () => {
    const ws = FakeSocket.all[0];
    ws.open();
    ws.receive({ t: 'welcome', devices: [living] });
    const before = usePlayerStore.getState().queueItems;

    usePlayerStore.setState({ isPlaying: true, volume: 0.3 });
    ws.receive({ t: 'command', action: 'pause' });
    ws.receive({ t: 'queue-changed' });
    await flush();

    expect(ws.sent.map(m => m.t)).toEqual(['hello']);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().queueItems).toBe(before);
  });

  it('rejoins as a player right away when switched back on', async () => {
    FakeSocket.all[0].open();
    useHubStore.getState().setJoined(true);

    const ws = FakeSocket.all[FakeSocket.all.length - 1];
    expect(FakeSocket.all.length).toBe(2);
    ws.open();
    await flush();
    expect(ws.sent[0]).toMatchObject({ t: 'hello', kind: 'desktop', deviceId: 'desk-me' });
  });
});
