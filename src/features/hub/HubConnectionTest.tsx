import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Wifi, WifiOff } from 'lucide-react';
import { useHubStore } from './hubStore';
import { testHubConnection, type HubTestResult } from './testHubConnection';

/**
 * "Test connection": signs in once with the address and token above and says what happened. The
 * result is only shown while they are still the ones it tested.
 */
export function HubConnectionTest() {
  const { t } = useTranslation();
  const url = useHubStore(s => s.url);
  const token = useHubStore(s => s.token);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ url: string; token: string; result: HubTestResult } | null>(null);
  const result = tested && tested.url === url && tested.token === token ? tested.result : null;

  const run = async () => {
    setTesting(true);
    setTested(null);
    const outcome = await testHubConnection(url, token);
    setTested({ url, token, result: outcome });
    setTesting(false);
  };

  const message = result
    ? result.kind === 'ok'
      ? t('settings.hubTestOk', { count: result.players })
      : t(`settings.hubTest_${result.kind}`)
    : '';

  return (
    <div className="hub-settings-test">
      <button
        type="button"
        className="btn btn-surface"
        onClick={() => void run()}
        disabled={testing}
      >
        <Wifi size={13} />
        {t('settings.testBtn')}
      </button>
      {testing && <div className="spinner" aria-hidden="true" />}
      {result && (
        <span
          className={`hub-settings-test-result${result.kind === 'ok' ? ' is-ok' : ' is-error'}`}
          role="status"
        >
          {result.kind === 'ok' ? <CheckCircle2 size={16} /> : <WifiOff size={16} />}
          {message}
        </span>
      )}
    </div>
  );
}
