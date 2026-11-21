import { useTranslation } from 'react-i18next';
import { Monitor, Radio, RefreshCw, Wifi } from 'lucide-react';
import { SettingsGroup, SettingsSubSection, SettingsToggle } from '@/features/settings';
import { useHubStore } from './hubStore';
import { HubConnectionFields } from './HubConnectionFields';
import { HubDeviceList } from './HubDeviceList';
import { HubStatusBadge } from './HubStatusBadge';

/** Settings → Integrations → Realtime hub: connection, connected devices, and settings sync. */
export function HubSettings() {
  const { t } = useTranslation();
  const set = useHubStore.getState();
  const enabled = useHubStore(s => s.enabled);
  const connected = useHubStore(s => s.status === 'connected');
  const syncPlaybackSettings = useHubStore(s => s.syncPlaybackSettings);

  return (
    <SettingsSubSection title={t('settings.hubTitle')} icon={<Radio size={16} />}>
      <div className="settings-card">
        <SettingsGroup
          title={t('settings.hubConnectionGroup')}
          icon={<Wifi size={14} />}
          action={enabled ? <HubStatusBadge /> : undefined}
        >
          <SettingsToggle
            desc={t('settings.hubDescription')}
            ariaLabel={t('settings.hubEnable')}
            checked={enabled}
            onChange={set.setEnabled}
          />
          {enabled && <HubConnectionFields />}
        </SettingsGroup>

        {enabled && connected && (
          <SettingsGroup title={t('settings.hubDevicesGroup')} icon={<Monitor size={14} />}>
            <HubDeviceList />
          </SettingsGroup>
        )}

        {enabled && (
          <SettingsGroup title={t('settings.hubSyncGroup')} icon={<RefreshCw size={14} />}>
            <SettingsToggle
              desc={t('settings.hubSyncSettingsDescription')}
              ariaLabel={t('settings.hubSyncSettings')}
              checked={syncPlaybackSettings}
              onChange={set.setSyncPlaybackSettings}
            />
          </SettingsGroup>
        )}
      </div>
    </SettingsSubSection>
  );
}
