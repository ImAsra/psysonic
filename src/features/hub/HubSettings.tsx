import { Radio } from 'lucide-react';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsField } from '@/features/settings/components/SettingsSubCard';
import { useHubStore } from './hubStore';
import { useTranslation } from 'react-i18next';

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
  const { enabled, url, token, deviceName, status, devices, remoteState, deviceId, syncPlaybackSettings } = useHubStore();

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
         <SettingsField label={t('settings.hubUrl')} desc={t('settings.hubUrlDescription')}>
           <input className="input" type="text" value={url} onChange={e => set.setUrl(e.target.value)}
             placeholder={t('settings.hubUrlPlaceholder')} autoComplete="off" spellCheck={false} />
          </SettingsField>
          <SettingsField label={t('settings.hubToken')}>
            <input className="input" type="password" value={token} onChange={e => set.setToken(e.target.value)}
              autoComplete="off" />
         </SettingsField>
         <SettingsField label={t('settings.hubDeviceName')}>
           <input className="input" type="text" value={deviceName} onChange={e => set.setDeviceName(e.target.value)}
             autoComplete="off" />
         </SettingsField>
         <SettingsField label={t('settings.hubStatus')} desc={t(STATUS_TEXT[status] ?? status)}>
           {status === 'connected' && (
             <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
               {devices.map(d => `${d.name}${d.id === deviceId ? ` (${t('settings.hubThisDevice')})` : ''}${d.active ? ' ▶' : ''}`).join(' · ')}
               {remoteState?.title && (
                 <div>{t('settings.hubRemote')}: {remoteState.playing ? '▶' : '⏸'} {remoteState.artist} – {remoteState.title}</div>
                )}
             </div>
           )}
          </SettingsField>
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
