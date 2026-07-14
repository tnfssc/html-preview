import { useEffect, useState } from 'react';
import {
  enabledStorage,
  githubTokenStorage,
} from '@/utils/storage';
import './App.css';
import { debugError, debugLog } from '@/utils/debug';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const TOKEN_CREATION_URL = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams(
  {
    name: 'GitHub HTML Preview',
    description:
      'Read-only private repository access for GitHub HTML Preview',
    contents: 'read',
    metadata: 'read',
    pull_requests: 'read',
  },
).toString()}`;

export default function App(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [token, setToken] = useState('');
  const [tokenConfigured, setTokenConfigured] = useState(false);
  const [editingToken, setEditingToken] = useState(true);
  const [savedLogin, setSavedLogin] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [storedEnabled, storedToken] = await Promise.all([
          enabledStorage.getValue(),
          githubTokenStorage.getValue(),
        ]);
        setEnabled(storedEnabled);
        setToken('');
        setTokenConfigured(Boolean(storedToken));
        setEditingToken(!storedToken);
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
      const login: string | null =
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        typeof (data as Record<string, unknown>).login === 'string'
          ? ((data as Record<string, unknown>).login as string)
          : null;
      await githubTokenStorage.setValue(candidate);
      setToken('');
      setTokenConfigured(true);
      setEditingToken(false);
      setSavedLogin(login);
      setSaveState('saved');
      setMessage(
        login
          ? `Token saved for @${login}. Repository access depends on repositories selected in GitHub.`
          : 'Token saved. Repository access depends on repositories selected in GitHub.',
      );
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
      await githubTokenStorage.setValue(null);
      setToken('');
      setTokenConfigured(false);
      setEditingToken(true);
      setSavedLogin(null);
      setSaveState('saved');
      setMessage('Private access removed.');
    } catch {
      setSaveState('error');
      setMessage('Could not remove private access.');
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

      <form className="section token-form" onSubmit={(event) => void saveToken(event)}>
        <label htmlFor="github-token">Private repository access</label>
        <p>
          Use a fine-grained token with read-only Contents, Metadata, and Pull
          requests access for selected repositories. Token stays in local
          extension storage.
        </p>
        <p>
          Organization repositories may require administrator approval or SSO
          authorization. While viewing GitHub, the extension can fall back to
          your signed-in browser session without exposing session cookies to
          preview content.
        </p>
        <a
          className="token-link"
          href={TOKEN_CREATION_URL}
          target="_blank"
          rel="noreferrer"
        >
          Create fine-grained token
        </a>
        {tokenConfigured && !editingToken ? (
          <p>
            Token saved{savedLogin ? ` for @${savedLogin}` : ''}. Repository
            access depends on repositories selected in GitHub.
          </p>
        ) : (
          <input
            id="github-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            placeholder="github_pat_…"
            disabled={!loaded || saveState === 'saving'}
          />
        )}
        <div className="button-row">
          {tokenConfigured && !editingToken ? (
            <button
              type="button"
              onClick={() => setEditingToken(true)}
              disabled={!loaded || saveState === 'saving'}
            >
              Replace
            </button>
          ) : (
            <button type="submit" disabled={!loaded || saveState === 'saving'}>
              Save token
            </button>
          )}
          <button
            type="button"
            onClick={() => void clearToken()}
            disabled={!loaded || !tokenConfigured || saveState === 'saving'}
          >
            Remove
          </button>
        </div>
      </form>

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

      <p
        className={`status status-${saveState}`}
        role={saveState === 'error' ? 'alert' : 'status'}
      >
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
