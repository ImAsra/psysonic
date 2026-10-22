import { Radio } from 'lucide-react';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsField } from '@/features/settings/components/SettingsSubCard';
import { useHubStore } from './hubStore';

const STATUS_TEXT: Record<string, string> = {
  off: 'Off',
  connecting: 'Connecting…',
  connected: 'Connected',
  unauthorized: 'Wrong token',
  incompatible: 'Hub/app version mismatch',
  error: 'Unreachable, retrying…',
};

// POC: plain English strings. Upstream PR will need i18n keys in every locale.
export function HubSettings() {
  const { enabled, url, token, deviceName, status, devices, remoteState, deviceId, syncPlaybackSettings } = useHubStore();
  const set = useHubStore.getState();

  return (
    <SettingsSubSection title="Realtime hub (optional)" icon={<Radio size={16} />}>
      <div className="settings-card">
        <SettingsGroup title="Self-hosted hub">
          <SettingsToggle
            desc="Instant sync and remote control between your devices via your own psysonic-hub container. Leave off to keep the normal Subsonic queue sync."
            ariaLabel="Enable realtime hub"
            checked={enabled}
            onChange={set.setEnabled}
          />
          <SettingsToggle
            desc="Keep crossfade, AutoDJ, gapless and similar playback settings identical on every connected device, so they can't disagree during a handoff."
            ariaLabel="Sync playback settings"
            checked={syncPlaybackSettings}
            onChange={set.setSyncPlaybackSettings}
          />
          <SettingsField label="Hub URL" desc="e.g. http://192.168.1.50:5533 or https://hub.example.com">
            <input className="input" type="text" value={url} onChange={e => set.setUrl(e.target.value)}
              placeholder="http://localhost:5533" autoComplete="off" spellCheck={false} />
          </SettingsField>
          <SettingsField label="Hub token">
            <input className="input" type="password" value={token} onChange={e => set.setToken(e.target.value)}
              autoComplete="off" />
          </SettingsField>
          <SettingsField label="This device's name">
            <input className="input" type="text" value={deviceName} onChange={e => set.setDeviceName(e.target.value)}
              autoComplete="off" />
          </SettingsField>
          <SettingsField label="Status" desc={STATUS_TEXT[status] ?? status}>
            {status === 'connected' && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {devices.map(d => `${d.name}${d.id === deviceId ? ' (this device)' : ''}${d.active ? ' ▶' : ''}`).join(' · ')}
                {remoteState?.title && (
                  <div>Remote: {remoteState.playing ? '▶' : '⏸'} {remoteState.artist} – {remoteState.title}</div>
                )}
              </div>
            )}
          </SettingsField>
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
