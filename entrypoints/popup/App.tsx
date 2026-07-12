import { useEffect, useState } from 'react';
import { enabledStorage } from '@/utils/storage';
import './App.css';

export default function App(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle',
  );

  useEffect(() => {
    async function load() {
      try {
        setEnabled(await enabledStorage.getValue());
        setLoaded(true);
      } catch {
        setSaveState('error');
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
    } catch {
      setEnabled(!next);
      setSaveState('error');
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
          HTML renders without scripts or external network requests. Use Open
          full preview when a public file needs JavaScript.
        </p>
      </div>

      <p className={`status status-${saveState}`} role="status">
        {saveState === 'saving' && 'Saving…'}
        {saveState === 'saved' && 'Saved'}
        {saveState === 'error' && 'Could not save setting.'}
      </p>
    </div>
  );
}
