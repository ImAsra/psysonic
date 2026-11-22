import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHubStore, type HubDevice } from './hubStore';
import { rejoinConflict } from './hubRejoin';
import { isPlayingHere, rejoinHub } from './hubClient';

/**
 * "Hub control" at the foot of the Play on menu: off, this device plays on its own; on again, it
 * rejoins, asking first when another device is playing too.
 */
export function HubControlSwitch({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const joined = useHubStore(s => s.joined);
  const [asking, setAsking] = useState<HubDevice | null>(null);

  const toggle = (on: boolean) => {
    if (!on) {
      setAsking(null);
      useHubStore.getState().setJoined(false);
      return;
    }
    const other = rejoinConflict(useHubStore.getState(), isPlayingHere());
    if (other) return setAsking(other);
    rejoinHub();
    onDone?.();
  };

  const choose = (choice: 'join' | 'playHere') => {
    setAsking(null);
    rejoinHub(choice);
    onDone?.();
  };

  if (asking) {
    return (
      <div className="hub-control hub-control--ask" role="group" aria-label={t('player.hubControl')}>
        <div className="hub-control__text">{t('player.hubAlsoPlaying', { name: asking.name })}</div>
        <div className="hub-control__choices">
          <button type="button" className="hub-control__choice" onClick={() => choose('join')}>
            <span className="hub-control__choice-label">{t('player.hubJoin')}</span>
            <span className="hub-control__hint">{t('player.hubJoinHint', { name: asking.name })}</span>
          </button>
          <button type="button" className="hub-control__choice" onClick={() => choose('playHere')}>
            <span className="hub-control__choice-label">{t('player.hubPlayHere')}</span>
            <span className="hub-control__hint">{t('player.hubPlayHereHint', { name: asking.name })}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="hub-control">
      <div className="hub-control__text">
        <div className="hub-control__label">{t('player.hubControl')}</div>
        <div className="hub-control__hint">{t(joined ? 'player.hubControlOnHint' : 'player.hubControlOffHint')}</div>
      </div>
      <label className="toggle-switch" aria-label={t('player.hubControl')}>
        <input type="checkbox" checked={joined} onChange={e => toggle(e.target.checked)} />
        <span className="toggle-track" />
      </label>
    </div>
  );
}
