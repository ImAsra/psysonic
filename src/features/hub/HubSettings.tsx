import { SettingsField, SettingsGroup, SettingsSubCard, SettingsSubSection, SettingsToggle } from '@/features/settings';
import { useHubStore } from './hubStore';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Radio } from 'lucide-react';
import { toHubWsUrl } from './hubClient';

const STATUS_TEXT: Record<string, string> = {
  off: 'settings.hubStatusOff',
  connecting: 'settings.hubStatusConnecting',
  connected: 'settings.hubStatusConnected',
  unauthorized: 'settings.hubStatusUnauthorized',
  incompatible: 'settings.hubStatusIncompatible',
  error: 'settings.hubStatusError',
};

export function HubSettings() {
  const set = useHubStore.getState();
  const { t } = useTranslation();
  const {
    enabled,
    url,
    token,
    deviceName,
    status,
    devices,
    remoteState,
    deviceId,
    syncPlaybackSettings,
  } = useHubStore();
  const insecureConnection = toHubWsUrl(url)?.startsWith('ws://') ?? false;

  return (
    <SettingsSubSection title={t('settings.hubTitle')} icon={<Radio size={16} />}>
      <div className="settings-card">
        <SettingsGroup title={t('settings.hubGroup')}>
          <SettingsToggle
            desc={t('settings.hubDescription')}
            ariaLabel={t('settings.hubEnable')}
            checked={enabled}
            onChange={set.setEnabled}
          />
          <SettingsToggle
            desc={t('settings.hubSyncSettingsDescription')}
            ariaLabel={t('settings.hubSyncSettings')}
            checked={syncPlaybackSettings}
            onChange={set.setSyncPlaybackSettings}
          />

          <SettingsSubCard style={{ marginTop: 'var(--space-3)' }}>
            <SettingsField
              label={t('settings.hubUrl')}
              desc={t('settings.hubUrlDescription')}
            >
              <input
                className="input"
                type="text"
                value={url}
                onChange={e => set.setUrl(e.target.value)}
                placeholder={t('settings.hubUrlPlaceholder')}
                autoComplete="off"
                spellCheck={false}
              />
            </SettingsField>

            {insecureConnection && (
              <div className="settings-privacy-notice" role="note">
                <AlertTriangle
                  size={16}
                  className="settings-privacy-notice-icon"
                  aria-hidden="true"
                />
                <div className="settings-privacy-notice-body">
                  {t('settings.hubInsecureWarning')}
                </div>
              </div>
            )}

            <SettingsField label={t('settings.hubToken')}>
              <input
                className="input"
                type="password"
                value={token}
                onChange={e => set.setToken(e.target.value)}
                autoComplete="off"
              />
            </SettingsField>

            <SettingsField label={t('settings.hubDeviceName')}>
              <input
                className="input"
                type="text"
                value={deviceName}
                onChange={e => set.setDeviceName(e.target.value)}
                autoComplete="off"
              />
            </SettingsField>
          </SettingsSubCard>

          <SettingsField
            label={t('settings.hubStatus')}
            desc={t(STATUS_TEXT[status] ?? status)}
          >
            {status === 'connected' && (
              <div className="hub-settings-status-details">
                <div className="hub-settings-device-list">
                  {devices.map(d => (
                    <span key={d.id} className="hub-settings-device">
                      {d.name}
                      {d.id === deviceId && ` (${t('settings.hubThisDevice')})`}
                      {d.active && ' ▶'}
                    </span>
                  ))}
                </div>
                {remoteState?.title && (
                  <div className="hub-settings-remote-track">
                    {t('settings.hubRemote')}: {remoteState.playing ? '▶' : '⏸'}{' '}
                    {remoteState.artist} – {remoteState.title}
                  </div>
                )}
              </div>
            )}
          </SettingsField>
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
