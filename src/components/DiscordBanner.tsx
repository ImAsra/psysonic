// src/components/DiscordBanner.tsx

import { X, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-shell';
import { useDiscordBanner } from '../hooks/useDiscordBanner';

const DISCORD_INVITE = 'https://discord.gg/AMnDRErm4u';

export default function DiscordBanner() {
  const { t } = useTranslation();
  const { visible, dismiss } = useDiscordBanner();

  if (!visible) return null;

  const handleJoin = (): void => {
    void open(DISCORD_INVITE);
    dismiss(false);
  };

  return (
    <div className="discord-banner" role="region" aria-label={t('discordBanner.ariaLabel')}>
      <div className="discord-banner-left">
        <MessageSquare size={14} />
        <span className="discord-banner-text">{t('discordBanner.message')}</span>
        <button type="button" className="discord-banner-join" onClick={handleJoin}>
          {t('discordBanner.join')}
        </button>
      </div>

      <div className="discord-banner-right">
        <button
          type="button"
          className="discord-banner-never"
          onClick={() => dismiss(true)}
        >
          {t('discordBanner.neverShow')}
        </button>
        <button
          type="button"
          className="discord-banner-close"
          onClick={() => dismiss(false)}
          aria-label={t('discordBanner.close')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}