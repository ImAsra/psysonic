import { describe, expect, it } from 'vitest';
import { defaultHubDeviceName, hubDeviceKind } from './deviceKind';

const ANDROID = 'Mozilla/5.0 (Linux; Android 15; motorola edge 50 fusion Build/V1UX35H; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

describe('hub device kind', () => {
  it('the phone apps join the hub as phones', () => {
    expect(hubDeviceKind(ANDROID)).toBe('phone');
    expect(hubDeviceKind(IPHONE)).toBe('phone');
  });

  it('the desktop apps join as desktops, even on Linux like Android', () => {
    expect(hubDeviceKind(LINUX)).toBe('desktop');
    expect(hubDeviceKind(MAC)).toBe('desktop');
    expect(hubDeviceKind(WINDOWS)).toBe('desktop');
  });

  it('a new install is named after its system', () => {
    expect(defaultHubDeviceName(ANDROID)).toBe('Psysonic Android');
    expect(defaultHubDeviceName(IPHONE)).toBe('Psysonic iPhone');
    expect(defaultHubDeviceName(WINDOWS)).toBe('Psysonic Desktop');
  });
});
