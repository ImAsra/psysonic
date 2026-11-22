import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { SettingsField, SettingsSubCard } from '@/features/settings';
import { useHubStore } from './hubStore';
import { toHubWsUrl } from './hubClient';
import { HubConnectionTest } from './HubConnectionTest';

/** Address, token and device name, with the connection test under them. */
export function HubConnectionFields() {
  const { t } = useTranslation();
  const set = useHubStore.getState();
  const url = useHubStore(s => s.url);
  const token = useHubStore(s => s.token);
  const deviceName = useHubStore(s => s.deviceName);
  const [showToken, setShowToken] = useState(false);
  const insecureConnection = toHubWsUrl(url)?.startsWith('ws://') ?? false;

  return (
    <SettingsSubCard style={{ marginTop: 'var(--space-3)' }}>
      <SettingsField label={t('settings.hubUrl')} desc={t('settings.hubUrlDescription')}>
        <input
          className="input"
          type="text"
          value={url}
          onChange={e => set.setUrl(e.target.value)}
          placeholder={t('settings.hubUrlPlaceholder')}
          aria-label={t('settings.hubUrl')}
          autoComplete="off"
          spellCheck={false}
        />
      </SettingsField>

      {insecureConnection && (
        <div className="settings-privacy-notice" role="note">
          <AlertTriangle size={16} className="settings-privacy-notice-icon" aria-hidden="true" />
          <div className="settings-privacy-notice-body">{t('settings.hubInsecureWarning')}</div>
        </div>
      )}

      <SettingsField label={t('settings.hubToken')} desc={t('settings.hubTokenDescription')}>
        <div className="hub-settings-token">
          <input
            className="input"
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => set.setToken(e.target.value)}
            aria-label={t('settings.hubToken')}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setShowToken(!showToken)}
            aria-label={showToken ? t('settings.hubHideToken') : t('settings.hubShowToken')}
            data-tooltip={showToken ? t('settings.hubHideToken') : t('settings.hubShowToken')}
          >
            {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </SettingsField>

      <SettingsField label={t('settings.hubDeviceName')} desc={t('settings.hubDeviceNameDescription')}>
        <input
          className="input"
          type="text"
          value={deviceName}
          onChange={e => set.setDeviceName(e.target.value)}
          aria-label={t('settings.hubDeviceName')}
          autoComplete="off"
        />
      </SettingsField>

      <HubConnectionTest />
    </SettingsSubCard>
  );
}
