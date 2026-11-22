import { useTranslation } from 'react-i18next';
import { useHubStore } from './hubStore';

const STATUS_TEXT: Record<string, string> = {
  off: 'settings.hubStatusOff',
  connecting: 'settings.hubStatusConnecting',
  connected: 'settings.hubStatusConnected',
  unauthorized: 'settings.hubStatusUnauthorized',
  incompatible: 'settings.hubStatusIncompatible',
  error: 'settings.hubStatusError',
};

/** The live connection state, as a small coloured badge next to the section's title. */
export function HubStatusBadge() {
  const { t } = useTranslation();
  const status = useHubStore(s => s.status);
  return (
    <span className={`hub-settings-status hub-settings-status--${status}`} role="status">
      <span className="hub-settings-status-dot" aria-hidden="true" />
      {t(STATUS_TEXT[status] ?? status)}
    </span>
  );
}
