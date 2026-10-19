import { useEffect, useState } from 'react';
import { Overview } from './pages/Overview';
import { BotDetail, BotEditor, BotsList } from './pages/Bots';
import { Analyze } from './pages/Analyze';
import { Checkpoints } from './pages/Checkpoints';
import { Wizard } from './pages/Wizard';
import { SettingsPage } from './pages/Settings';

type Theme = 'light' | 'dark' | 'system';

function useRoute(): string[] {
  const parse = () =>
    (window.location.hash.replace(/^#\/?/, '') || 'overview').split('/').map(decodeURIComponent);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      document.getElementById('main')?.focus();
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('gcm-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const NAV = [
  ['overview', 'Overview'],
  ['bots', 'Bots'],
  ['analyze', 'Context analysis'],
  ['checkpoints', 'Checkpoints'],
  ['wizard', 'Handoff wizard'],
  ['settings', 'Settings'],
] as const;

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('gcm-theme', theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const [section, a, b] = route;
  let page;
  switch (section) {
    case 'bots':
      page = !a ? (
        <BotsList />
      ) : a === 'new' ? (
        <BotEditor />
      ) : b === 'edit' ? (
        <BotEditor botId={a} />
      ) : (
        <BotDetail botId={a} />
      );
      break;
    case 'analyze':
      page = <Analyze botId={a} />;
      break;
    case 'checkpoints':
      page = <Checkpoints botId={a} checkpointId={b} />;
      break;
    case 'wizard':
      page = <Wizard botId={a} handoffId={b} />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    default:
      page = <Overview />;
  }

  return (
    <div className="shell">
      <a
        className="skip"
        href="#main"
        onClick={(e) => (e.preventDefault(), document.getElementById('main')?.focus())}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <div>
            <div className="brand-name">Grok Context Manager</div>
            <div className="brand-tag">Keep your bots. Keep their knowledge.</div>
          </div>
        </div>
        <nav aria-label="Main">
          {NAV.map(([key, label]) => (
            <a
              key={key}
              href={`#/${key}`}
              className={
                section === key || (key === 'overview' && !NAV.some(([k]) => k === section))
                  ? 'active'
                  : ''
              }
              aria-current={section === key ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <label className="theme">
            <span>Theme</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <p className="tiny">
            Local only · no telemetry. GCM manages its own copy of context; it cannot read or reset
            Grok Bot conversations.
          </p>
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        {page}
      </main>
    </div>
  );
}
