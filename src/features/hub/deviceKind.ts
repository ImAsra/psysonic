/**
 * What this device is on the hub. The phone apps run the same code in a web view whose user
 * agent names the system, so no build flag is needed.
 */
export function hubDeviceKind(userAgent = navigator.userAgent): 'phone' | 'desktop' {
  return /Android|iPhone|iPad|iPod/i.test(userAgent) ? 'phone' : 'desktop';
}

/** The name a new install shows on the hub until the user picks one. */
export function defaultHubDeviceName(userAgent = navigator.userAgent): string {
  if (/Android/i.test(userAgent)) return 'Psysonic Android';
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'Psysonic iPhone';
  return 'Psysonic Desktop';
}
