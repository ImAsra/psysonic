import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testHubConnection } from './testHubConnection';

/** A stand-in socket each test drives by hand. */
class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  refuse(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const Socket = FakeSocket as unknown as new (url: string) => WebSocket;

describe('testHubConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('signs in like the app (as a remote, not a player) and counts the players it finds', async () => {
    const result = testHubConnection('192.168.1.2:5533', 'secret-token', { Socket });
    const ws = FakeSocket.last;
    expect(ws.url).toBe('ws://192.168.1.2:5533/ws');
    ws.open();
    expect(ws.sent[0]).toMatchObject({ t: 'hello', token: 'secret-token', kind: 'web' });

    const me = ws.sent[0].deviceId;
    ws.receive({ t: 'welcome', devices: [{ id: 'desk', kind: 'desktop' }, { id: 'page', kind: 'web' }, { id: me, kind: 'web' }] });
    expect(await result).toEqual({ kind: 'ok', players: 1 });
    expect(ws.closed).toBe(true);
  });

  it('tells a wrong token, a version mismatch and a lockout apart', async () => {
    for (const [code, kind] of [
      [4005, 'unauthorized'],
      [4004, 'incompatible'],
      [4011, 'locked_out'],
      [4010, 'too_many'],
    ] as const) {
      const result = testHubConnection('https://hub.example.com', 't0ken', { Socket });
      FakeSocket.last.open();
      FakeSocket.last.refuse(code);
      expect(await result).toEqual({ kind });
    }
  });

  it('a connection that never opens is unreachable', async () => {
    const result = testHubConnection('http://10.0.0.9:5533', 't0ken', { Socket });
    FakeSocket.last.refuse(1006);
    expect(await result).toEqual({ kind: 'unreachable' });
  });

  it('something that answers but is not a hub says so', async () => {
    const result = testHubConnection('http://10.0.0.9:80', 't0ken', { Socket });
    FakeSocket.last.open();
    FakeSocket.last.receive('<html>');
    expect(await result).toEqual({ kind: 'not_a_hub' });
  });

  it('JSON that is not a hub message is not a hub, not a timeout', async () => {
    for (const data of ['null', '42', '[]', { t: 'welcome', devices: {} }, { t: 'welcome', devices: [null] }]) {
      const result = testHubConnection('http://10.0.0.9:80', 't0ken', { Socket, timeoutMs: 1000 });
      FakeSocket.last.open();
      FakeSocket.last.receive(data);
      expect(await result).toEqual({ kind: 'not_a_hub' });
    }
  });

  it('gives up after the timeout when the hub never answers', async () => {
    const result = testHubConnection('http://10.0.0.9:5533', 't0ken', { Socket, timeoutMs: 1000 });
    FakeSocket.last.open();
    vi.advanceTimersByTime(1000);
    expect(await result).toEqual({ kind: 'timeout' });
    expect(FakeSocket.last.closed).toBe(true);
  });

  it('asks for the missing piece before trying to connect', async () => {
    expect(await testHubConnection('', 't0ken', { Socket })).toEqual({ kind: 'missing_url' });
    expect(await testHubConnection('ftp://hub', 't0ken', { Socket })).toEqual({ kind: 'missing_url' });
    expect(await testHubConnection('http://hub:5533', '  ', { Socket })).toEqual({ kind: 'missing_token' });
  });
});
