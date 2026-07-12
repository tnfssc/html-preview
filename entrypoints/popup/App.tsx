import { useEffect, useState } from 'react';
import {
  enabledStorage,
  githubTokenStorage,
  privateFullPreviewStorage,
} from '@/utils/storage';
import './App.css';
import { debugError, debugLog } from '@/utils/debug';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function App(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [token, setToken] = useState('');
  const [privateFullPreview, setPrivateFullPreview] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [storedEnabled, storedToken, storedPrivateFullPreview] =
          await Promise.all([
            enabledStorage.getValue(),
            githubTokenStorage.getValue(),
            privateFullPreviewStorage.getValue(),
          ]);
        setEnabled(storedEnabled);
        setToken(storedToken ?? '');
        setPrivateFullPreview(storedPrivateFullPreview);
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

  async function saveToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setSaveState('error');
      setMessage('Enter a fine-grained GitHub token.');
      return;
    }
    setSaveState('saving');
    setMessage('Checking token…');
    debugLog('popup', 'token-validation-start');
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: githubHeaders(candidate),
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
      const data = (await response.json()) as unknown;
      const login =
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        typeof (data as Record<string, unknown>).login === 'string'
          ? (data as Record<string, unknown>).login
          : null;
      await githubTokenStorage.setValue(candidate);
      setToken(candidate);
      setSaveState('saved');
      setMessage(login ? `Private access saved for ${login}.` : 'Private access saved.');
      debugLog('popup', 'token-validation-complete', {
        loginReturned: Boolean(login),
      });
    } catch (error) {
      debugError('popup', 'token-validation-failed', error);
      setSaveState('error');
      setMessage(error instanceof Error ? error.message : 'Token validation failed.');
    }
  }

  async function clearToken() {
    setSaveState('saving');
    setMessage('Removing private access…');
    try {
      await Promise.all([
        githubTokenStorage.setValue(null),
        privateFullPreviewStorage.setValue(false),
      ]);
      setToken('');
      setPrivateFullPreview(false);
      setSaveState('saved');
      setMessage('Private access removed.');
    } catch {
      setSaveState('error');
      setMessage('Could not remove private access.');
    }
  }

  async function updatePrivateFullPreview(next: boolean) {
    setPrivateFullPreview(next);
    setSaveState('saving');
    setMessage('Saving…');
    try {
      await privateFullPreviewStorage.setValue(next);
      setSaveState('saved');
      setMessage('Saved');
    } catch {
      setPrivateFullPreview(!next);
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
          onChange={(e) => void updateEnabled(e.target.checked)}
          disabled={!loaded || saveState === 'saving'}
        />
        <span>Enable extension</span>
      </label>

      <div className="section">
        <strong>Safe inline previews</strong>
        <p>
          Public and private HTML render without scripts or external network
          requests.
        </p>
      </div>

      <form className="section token-form" onSubmit={(event) => void saveToken(event)}>
        <label htmlFor="github-token">Private repository access</label>
        <p>
          Use a fine-grained token with read-only Contents, Metadata, and Pull
          requests access for selected repositories. Token stays in local
          extension storage.
        </p>
        <input
          id="github-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          placeholder="github_pat_…"
          disabled={!loaded || saveState === 'saving'}
        />
        <div className="button-row">
          <button type="submit" disabled={!loaded || saveState === 'saving'}>
            Save token
          </button>
          <button
            type="button"
            onClick={() => void clearToken()}
            disabled={!loaded || !token || saveState === 'saving'}
          >
            Remove
          </button>
        </div>
      </form>

      <label className="row warning-row">
        <input
          type="checkbox"
          checked={privateFullPreview}
          onChange={(event) =>
            void updatePrivateFullPreview(event.target.checked)
          }
          disabled={!loaded || !token || saveState === 'saving'}
        />
        <span>
          Allow executable private previews. Repository scripts can transmit
          private content to external servers.
        </span>
      </label>

      {import.meta.env.MODE === 'debug' && (
        <div className="section">
          <strong>Diagnostic build</strong>
          <p>
            Open GitHub DevTools and extension-page DevTools, reproduce the
            problem, then copy console entries filtered by
            {' '}
            <code>[gh-html-preview:debug]</code>. Tokens and file contents are
            never logged.
          </p>
        </div>
      )}

      <p className={`status status-${saveState}`} role="status">
        {message}
      </p>
    </div>
  );
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
