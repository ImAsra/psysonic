import { useAuthStore } from '@/store/authStore';

/**
 * Opaque identifiers for "which music server + account is this device using".
 * The hub compares them to refuse handing playback to a device that would load a different
 * queue. Only hashes leave the device: never the address, the user name or the password.
 * Two hashes (main and alternate address) so a device that reaches the same server over
 * its LAN address still matches one that uses the public address.
 */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, '');
  }
}

export async function currentServerKeys(): Promise<string[]> {
  try {
    const server = useAuthStore.getState().getActiveServer();
    if (!server) return [];
    // Subsonic servers match user names without regard to case, so "Name" and "name" are one account.
    const user = (server.username ?? '').trim().toLowerCase();
    const urls = [server.url, server.alternateUrl].filter((u): u is string => !!u && !!u.trim());
    return await Promise.all(urls.map(u => sha256(`${normalizeUrl(u)}\n${user}`)));
  } catch {
    return []; // unknown: the hub treats that as compatible
  }
}
