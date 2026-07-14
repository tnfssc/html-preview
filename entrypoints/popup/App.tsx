import { useEffect, useState } from 'react';
import { enabledStorage, purgeLegacyCredentials } from '@/utils/storage';
import './App.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function App(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [storedEnabled] = await Promise.all([
          enabledStorage.getValue(),
          purgeLegacyCredentials(),
        ]);
        setEnabled(storedEnabled);
        setLoaded(true);
      } catch {
        setSaveState('error');
        setMessage('Could not load settings.');
      }
    }
    void load();
  }, []);

  async function updateEnabled(next: boolean) {
    setEnabled(next);
    setSaveState('saving');
    try {
      await enabledStorage.setValue(next);
      setSaveState('saved');
      setMessage('Saved');
    } catch {
      setEnabled(!next);
      setSaveState('error');
      setMessage('Could not save setting.');
    }
  }

  return (
    <div className="popup">
      <div className="popup-header">
        <h1>GitHub HTML Preview</h1>
      </div>

      <label className="row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => void updateEnabled(event.target.checked)}
          disabled={!loaded || saveState === 'saving'}
        />
        <span>Show previews on GitHub HTML files and pull requests</span>
      </label>

      <div className="section">
        <strong>Executable previews</strong>
        <p>
          HTML previews run repository scripts in isolated frames. Scripts can
          send preview data to external services. Only preview code you trust.
        </p>
      </div>

      <div className="section">
        <strong>How to use</strong>
        <p>
          Open an .html or .htm file on GitHub and choose Preview beside Code.
          Use the same Preview control on pull requests, commits, and
          comparisons.
        </p>
      </div>

      <div className="section">
        <strong>Private and organization repositories</strong>
        <p>
          Private files use your current signed-in GitHub browser session. Sign
          into organization SSO in the GitHub tab before choosing Preview. The
          extension never asks for or stores a personal access token.
        </p>
      </div>

      {import.meta.env.MODE === 'debug' && (
        <div className="section">
          <strong>Diagnostic build</strong>
          <p>
            Open GitHub DevTools and extension-page DevTools, reproduce the
            problem, then copy console entries filtered by{' '}
            <code>[gh-html-preview:debug]</code>. Session cookies and file
            contents are never logged.
          </p>
        </div>
      )}

      <p
        className={`status status-${saveState}`}
        role={saveState === 'error' ? 'alert' : 'status'}
      >
        {message}
      </p>
    </div>
  );
}
