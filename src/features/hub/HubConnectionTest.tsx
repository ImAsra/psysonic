import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Wifi, WifiOff } from 'lucide-react';
import { useHubStore } from './hubStore';
import { testHubConnection, type HubTestResult } from './testHubConnection';

/** "Test connection": signs in once with the address and token above and says what happened. */
export function HubConnectionTest() {
  const { t } = useTranslation();
  const url = useHubStore(s => s.url);
  const token = useHubStore(s => s.token);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<HubTestResult | null>(null);

  const run = async () => {
    setTesting(true);
    setResult(null);
    setResult(await testHubConnection(url, token));
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
