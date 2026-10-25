import type { HubDevice } from './hubStore';

/**
 * Can playback be handed from `source` to `target`? They must use the same music server and
 * account (the queue travels through it). A device that does not say which one counts as
 * compatible. `enabled` is false when the hub has the check switched off.
 */
export function deviceCompatible(
  source: Pick<HubDevice, 'server'> | undefined,
  target: Pick<HubDevice, 'server'> | undefined,
  enabled = true,
): boolean {
  if (!enabled) return true;
  const a = source?.server;
  const b = target?.server;
  return !a?.length || !b?.length || a.some(k => b.includes(k));
}
