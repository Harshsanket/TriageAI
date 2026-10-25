import { Suspense } from 'react';
import type { ReactElement } from 'react';

import { navEntries, useSystemManifest } from './host/manifest';
import { navigate, useRoute } from './host/router';
import { moduleRegistry } from './modules/registry';
import FeedbackPage from './system/FeedbackPage';
import LoginPage from './system/LoginPage';
import RunDetailPage from './system/RunDetailPage';
import SystemPage from './system/SystemPage';
import RunsPage from './system/RunsPage';

/** Host-owned pages (kernel/ops surface, not module-gated). */
const hostPages: Array<{ label: string; path: string; render: (route: string) => ReactElement }> = [
  { label: 'Runs', path: '/runs', render: (route) => renderRuns(route) },
  { label: 'Feedback', path: '/feedback', render: () => <FeedbackPage /> },
  { label: 'System', path: '/system', render: () => <SystemPage /> },
];

function renderRuns(route: string): ReactElement {
  const detail = /^\/runs\/([^/]+)$/.exec(route);
  return detail ? <RunDetailPage runId={detail[1] as string} /> : <RunsPage />;
}

export function App() {
  const manifestState = useSystemManifest();
  const route = useRoute();

  if (manifestState.phase === 'unauthenticated') {
    return <LoginPage />;
  }

  if (manifestState.phase !== 'ready') {
    return (
      <main>
        <p>
          {manifestState.phase === 'loading'
            ? 'Loading modules…'
            : `Module host error: ${manifestState.message}`}
        </p>
      </main>
    );
  }

  const nav = navEntries(manifestState.manifest);
  const hostNav = hostPages.map(({ label, path }) => ({ label, path, order: 900 }));
  const active =
    nav.find((entry) => entry.path === route) ??
    nav.find((entry) => route.startsWith(`${entry.path}/`));
  const hostPage = hostPages.find(
    (entry) => route === entry.path || route.startsWith(`${entry.path}/`),
  );
  const Module = active ? moduleRegistry[active.path.replace('/', '')] : undefined;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ padding: '0.5rem 1rem', borderBottom: '1px solid #ddd' }}>
        <button type="button" onClick={() => navigate('/')} style={{ fontWeight: 700 }}>
          TriageAI
        </button>
        {nav.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => navigate(entry.path)}
            style={{ marginInlineStart: 8 }}
          >
            {entry.label}
          </button>
        ))}
        {hostNav.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => navigate(entry.path)}
            style={{ marginInlineStart: 8, opacity: 0.85 }}
          >
            {entry.label}
          </button>
        ))}
      </header>
      <main style={{ padding: '1rem' }}>
        <Suspense fallback={<p>Loading module…</p>}>
          {hostPage ? (
            hostPage.render(route)
          ) : Module ? (
            <Module />
          ) : (
            <section>
              <h1>TriageAI</h1>
              <p>No module is active at this path. Pick a module from the header.</p>
            </section>
          )}
        </Suspense>
      </main>
    </div>
  );
}
