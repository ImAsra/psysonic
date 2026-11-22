import { toHubWsUrl } from './hubClient';

export type HubTestProblem =
  | 'missing_url'
  | 'missing_token'
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'incompatible'
  | 'locked_out'
  | 'too_many'
  | 'not_a_hub';

/** What a connection test found out. */
export type HubTestResult = { kind: 'ok'; players: number } | { kind: HubTestProblem };

const PROTOCOL = 1;
const TIMEOUT_MS = 6_000;

/** Close codes the hub uses for a refused sign-in (see the hub's docs/PROTOCOL.md). */
const REFUSED: Record<number, HubTestProblem> = {
  4004: 'incompatible',
  4005: 'unauthorized',
  4010: 'too_many',
  4011: 'locked_out',
};

type SocketCtor = new (url: string) => WebSocket;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Signs in to the hub once with this address and token, the way the app does, and reports what
 * happened. It joins as a short-lived remote (not a player), so other devices never see it as a
 * place to play, and leaves right after the hub's welcome.
 */
export function testHubConnection(
  url: string,
  token: string,
  { Socket = WebSocket as SocketCtor, timeoutMs = TIMEOUT_MS }: { Socket?: SocketCtor; timeoutMs?: number } = {},
): Promise<HubTestResult> {
  const wsUrl = toHubWsUrl(url);
  if (!url.trim() || !wsUrl) return Promise.resolve({ kind: 'missing_url' });
  if (!token.trim()) return Promise.resolve({ kind: 'missing_token' });

  return new Promise(resolve => {
    let settled = false;
    let ws: WebSocket;
    const finish = (result: HubTestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);

    try {
      ws = new Socket(wsUrl);
    } catch {
      clearTimeout(timer);
      resolve({ kind: 'missing_url' });
      return;
    }

    const deviceId = 'test-' + Math.random().toString(36).slice(2, 10);
    ws.onopen = () =>
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, token, deviceId, name: 'Psysonic connection test', kind: 'web' }));
    ws.onmessage = ev => {
      let m: unknown;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return finish({ kind: 'not_a_hub' });
      }
      if (!isObject(m)) return finish({ kind: 'not_a_hub' });
      if (m.t !== 'welcome') return;
      const devices = m.devices ?? [];
      if (!Array.isArray(devices) || !devices.every(isObject)) return finish({ kind: 'not_a_hub' });
      const players = devices.filter(d => d.kind !== 'web' && d.id !== deviceId).length;
      finish({ kind: 'ok', players });
    };
    ws.onclose = ev => finish({ kind: REFUSED[ev.code] ?? 'unreachable' });
  });
}
