import { Suspense, useEffect } from 'react';
import type { ReactElement } from 'react';

import type { SystemManifest } from '@triageai/contracts';

import ConfigPage, { ConfigView } from './config/ConfigPage';
import { useSetupStatus } from './config/setupApi';
import HomePage from './home/HomePage';
import { useAppearanceSync } from './host/appearance';
import { JobsTray } from './host/JobsTray';
import { navEntries, useSystemManifest } from './host/manifest';
import { useChatSidebarPreference } from './host/preferences';
import { navigate, useRoute } from './host/router';
import { moduleComponent } from './modules/registry';
import DashboardPage from './system/DashboardPage';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { OfflineBanner } from './ui/OfflineBanner';
import FeedbackPage from './system/FeedbackPage';
import LoginPage from './system/LoginPage';
import RunDetailPage from './system/RunDetailPage';
import RunsPage from './system/RunsPage';

/** Host-owned pages (kernel/ops surface, not module-gated). */
const hostPages: Array<{
  label: string;
  path: string;
  render: (route: string, manifest: SystemManifest) => ReactElement;
}> = [
  {
    label: 'Dashboard',
    path: '/dashboard',
    render: (_route, manifest) => <DashboardPage manifest={manifest} />,
  },
  { label: 'Runs', path: '/runs', render: (route) => renderRuns(route) },
  { label: 'Feedback', path: '/feedback', render: () => <FeedbackPage /> },
  { label: 'Config', path: '/config', render: () => <ConfigPage /> },
];

function renderRuns(route: string): ReactElement {
  const detail = /^\/runs\/([^/]+)$/.exec(route);
  return detail ? <RunDetailPage runId={detail[1] as string} /> : <RunsPage />;
}

/** Nothing configured, or an unknown path: show config and fix the URL. */
function ConfigFallback() {
  useEffect(() => {
    navigate('/config', { replace: true });
  }, []);
  return (
    <main className="app-main">
      <ConfigPage />
    </main>
  );
}

export function App() {
  useAppearanceSync();
  const sidebar = useChatSidebarPreference();
  const manifestState = useSystemManifest();
  const route = useRoute();
  const setup = useSetupStatus();

  // 23.3: one chat. Legacy /chat paths move to the home conversation.
  const legacyChatId = /^\/chat\/(.+)$/.exec(route)?.[1] ?? null;
  const chatRedirect =
    route === '/chat' || route === '/chat/'
      ? '/'
      : legacyChatId
        ? `/?c=${encodeURIComponent(legacyChatId)}`
        : null;
  const systemRedirect = route === '/system' || route.startsWith('/system/') ? '/dashboard' : null;

  useEffect(() => {
    if (chatRedirect) navigate(chatRedirect, { replace: true });
  }, [chatRedirect]);

  useEffect(() => {
    if (systemRedirect) navigate(systemRedirect, { replace: true });
  }, [systemRedirect]);

  const setupPending = setup.phase === 'ready' && setup.status.state !== 'complete';
  const noConfiguredModule =
    manifestState.phase === 'ready' && navEntries(manifestState.manifest).length === 0;

  // A fresh install (or a configuration with no user-facing module) always
  // lands on /config instead of an empty app shell.
  useEffect(() => {
    if (setup.phase !== 'ready') return;
    if ((setupPending || noConfiguredModule) && route !== '/config') {
      navigate('/config', { replace: true });
    }
  }, [route, setup.phase, setupPending, noConfiguredModule]);

  // Until first-run setup is known to be complete the app shows setup only:
  // no header, nav, module pages or pollers exist yet (ADR-0024).
  if (setup.phase === 'loading') {
    return (
      <main className="app-main">
        <p>Loading setup…</p>
      </main>
    );
  }
  if (setupPending) {
    return (
      <main className="app-main">
        <ConfigView status={setup.status} refresh={setup.refresh} />
      </main>
    );
  }

  if (manifestState.phase === 'unauthenticated') {
    return <LoginPage />;
  }

  if (manifestState.phase !== 'ready') {
    return (
      <main className="app-main">
        <p>
          {manifestState.phase === 'loading'
            ? 'Loading modules…'
            : `Module host error: ${manifestState.message}`}
        </p>
      </main>
    );
  }

  // With no user-facing module there is nothing to host: render the config
  // page directly (and keep the URL on /config) instead of an empty shell.
  if (noConfiguredModule) {
    return <ConfigFallback />;
  }

  if (chatRedirect) {
    return (
      <main className="app-main">
        <p>Opening chat…</p>
      </main>
    );
  }

  if (systemRedirect) {
    return (
      <main className="app-main">
        <p>Opening dashboard…</p>
      </main>
    );
  }

  const nav = navEntries(manifestState.manifest);
  const hostNav = hostPages.map(({ label, path }) => ({ label, path, order: 900 }));
  const isHome = route === '/';
  const chatEnabled = manifestState.manifest.modules.some((module) => module.id === 'chat');
  const isCurrent = (path: string) =>
    path === '/' ? route === '/' : route === path || route.startsWith(`${path}/`);
  const active =
    nav.find((entry) => entry.path === route) ??
    nav.find((entry) => route.startsWith(`${entry.path}/`));
  const hostPage = hostPages.find(
    (entry) => route === entry.path || route.startsWith(`${entry.path}/`),
  );
  const manifestModule = active
    ? manifestState.manifest.modules.find((entry) =>
        entry.manifest.nav.some((nav) => nav.path === active.path),
      )
    : undefined;
  const Module = active ? moduleComponent(active.path, manifestModule?.bundleUrl) : undefined;

  return (
    <div className={isHome ? 'app-shell app-shell--home' : 'app-shell'}>
      <OfflineBanner />
      <header className={isHome ? 'app-header app-header--overlay' : 'app-header'}>
        <button className="app-brand" type="button" onClick={() => navigate('/')}>
          TriageAI
        </button>
        <nav className="app-nav" aria-label="Primary">
          {nav.map((entry) => (
            <button
              key={entry.path}
              className={`app-nav__item${isCurrent(entry.path) ? ' app-nav__item--active' : ''}`}
              type="button"
              aria-current={isCurrent(entry.path) ? 'page' : undefined}
              onClick={() => navigate(entry.path)}
            >
              {entry.label}
            </button>
          ))}
          {hostNav.map((entry) => (
            <button
              key={entry.path}
              className={`app-nav__item app-nav__item--system${isCurrent(entry.path) ? ' app-nav__item--active' : ''}`}
              type="button"
              aria-current={isCurrent(entry.path) ? 'page' : undefined}
              onClick={() => navigate(entry.path)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>
      <JobsTray onOpen={(job) => job.runId && navigate(`/runs/${job.runId}`)} />
      {isHome ? (
        <HomePage
          manifest={manifestState.manifest}
          sidebarOpen={chatEnabled && sidebar.open}
          onToggleSidebar={() => sidebar.setOpen(!sidebar.open)}
        />
      ) : (
        <main className="app-main">
          <Suspense fallback={<p>Loading module…</p>}>
            <ErrorBoundary resetKey={route} label={hostPage?.label ?? active?.label ?? 'This page'}>
              {hostPage ? (
                hostPage.render(route, manifestState.manifest)
              ) : Module ? (
                <Module />
              ) : (
                <ConfigFallback />
              )}
            </ErrorBoundary>
          </Suspense>
        </main>
      )}
    </div>
  );
}
