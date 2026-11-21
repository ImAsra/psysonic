import { useTranslation } from 'react-i18next';
import { Globe, Monitor, Smartphone } from 'lucide-react';
import { useHubStore } from './hubStore';

const ICONS = { desktop: Monitor, phone: Smartphone, web: Globe };

/** The devices connected to the hub, with this one and the playing one marked. */
export function HubDeviceList() {
  const { t } = useTranslation();
  const devices = useHubStore(s => s.devices);
  const deviceId = useHubStore(s => s.deviceId);
  const remoteState = useHubStore(s => s.remoteState);

  return (
    <div className="hub-settings-devices">
      {devices.map(d => {
        const Icon = ICONS[d.kind as keyof typeof ICONS] ?? Monitor;
        return (
          <div key={d.id} className={`hub-settings-device${d.active ? ' is-active' : ''}`}>
            <Icon size={16} aria-hidden="true" />
            <span className="hub-settings-device-name">{d.name}</span>
            {d.id === deviceId && <span className="hub-settings-chip">{t('settings.hubThisDevice')}</span>}
            {d.active && <span className="hub-settings-chip is-playing">{t('settings.hubPlaying')}</span>}
          </div>
        );
      })}
      {remoteState?.title && (
        <div className="hub-settings-remote-track">
          {t('settings.hubRemote')}: {remoteState.playing ? '▶' : '⏸'} {remoteState.artist} – {remoteState.title}
        </div>
      )}
    </div>
  );
}
