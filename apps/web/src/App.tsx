import { Suspense } from 'react';

import { navEntries, useSystemManifest } from './host/manifest';
import { navigate, useRoute } from './host/router';
import { moduleRegistry } from './modules/registry';

export function App() {
  const manifestState = useSystemManifest();
  const route = useRoute();

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
  const active =
    nav.find((entry) => entry.path === route) ??
    nav.find((entry) => route.startsWith(`${entry.path}/`));
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
      </header>
      <main style={{ padding: '1rem' }}>
        <Suspense fallback={<p>Loading module…</p>}>
          {Module ? (
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
