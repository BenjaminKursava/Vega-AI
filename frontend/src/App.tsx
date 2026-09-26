import { useEffect, useState, useCallback, useRef } from 'react';
import { Routes, Route } from 'react-router';
import { Layout } from './components/Layout';
import { ChatPage } from './pages/ChatPage';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { GetStartedPage } from './pages/GetStartedPage';
import { AgentsPage } from './pages/AgentsPage';
import { DataSourcesPage } from './pages/DataSourcesPage';
import { LogsPage } from './pages/LogsPage';
import { CommandPalette } from './components/CommandPalette';
import { SetupScreen } from './components/SetupScreen';
import { Toaster } from './components/ui/sonner';
import { useAppStore } from './lib/store';
import { fetchModels, fetchServerInfo, fetchSavings, isTauri } from './lib/api';
import { AuthScreen } from './components/AuthScreen';
import {
  adoptActiveSession,
  continueAsGuest,
  fetchAuthStatus,
  isGuestActive,
  GUEST_USER,
} from './lib/auth';

export default function App() {
  const [setupDone, setSetupDone] = useState(!isTauri());
  const handleSetupReady = useCallback(() => setSetupDone(true), []);

  // Local account gate. Nothing renders until the server says who (if
  // anyone) is signed in on this machine. The user lives in the store so
  // the sidebar's account menu can switch accounts and sign out.
  const [authChecked, setAuthChecked] = useState(false);
  const [hasAccount, setHasAccount] = useState(false);
  const authUser = useAppStore((s) => s.authUser);
  const setAuthUser = useAppStore((s) => s.setAuthUser);
  const addingAccount = useAppStore((s) => s.addingAccount);
  const setAddingAccount = useAppStore((s) => s.setAddingAccount);

  const setModels = useAppStore((s) => s.setModels);
  const setModelsLoading = useAppStore((s) => s.setModelsLoading);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const setServerInfo = useAppStore((s) => s.setServerInfo);
  const setSavings = useAppStore((s) => s.setSavings);
  const settings = useAppStore((s) => s.settings);
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const savings = useAppStore((s) => s.savings);

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    if (settings.theme === 'dark') root.classList.add('dark');
    else if (settings.theme === 'light') root.classList.add('light');
  }, [settings.theme]);

  // Sync overlay conversations into the main app
  const importOverlay = useAppStore((s) => s.importOverlayConversation);
  useEffect(() => {
    if (!isTauri()) return;
    importOverlay();
    const interval = setInterval(importOverlay, 5000);
    return () => clearInterval(interval);
  }, [importOverlay]);

  // Fetch models on mount
  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m);
        if (!selectedModel && m.length > 0) setSelectedModel(m[0].id);
      })
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch server info
  useEffect(() => {
    fetchServerInfo().then(setServerInfo).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll savings from the LOCAL server only. The old version of this
  // effect also uploaded name, email and usage stats to a third-party
  // Supabase leaderboard every 30 s — that upload has been removed.
  useEffect(() => {
    const refresh = () => fetchSavings().then(setSavings).catch(() => {});
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Who is signed in on this machine?
  useEffect(() => {
    fetchAuthStatus()
      .then((status) => {
        if (status.user) {
          // Backfill first: a session created before multi-account support
          // has no entry in the account list, which empties the menu.
          adoptActiveSession(status.user);
          setAuthUser(status.user);
        } else if (isGuestActive()) {
          setAuthUser(GUEST_USER);
        }
        setHasAccount(status.has_account);
      })
      .catch(() => {
        // Server unreachable. A guest has no session to validate, so let
        // them straight in; everyone else gets the auth screen, which
        // reports the connection problem when they try to sign in.
        if (isGuestActive()) setAuthUser(GUEST_USER);
      })
      .finally(() => setAuthChecked(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSystemPanel = useAppStore((s) => s.toggleSystemPanel);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault();
        toggleSystemPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen, toggleSystemPanel]);

  // Desktop auto-update check — disabled during local development.
  // Re-enable for production releases by uncommenting below.
  // const updateChecked = useRef(false);
  // useEffect(() => {
  //   if (!isTauri() || updateChecked.current) return;
  //   updateChecked.current = true;
  //   (async () => {
  //     try {
  //       const { check } = await import('@tauri-apps/plugin-updater');
  //       const update = await check();
  //       if (update) {
  //         await update.downloadAndInstall();
  //         const { toast } = await import('sonner');
  //         toast.info('Update ready', {
  //           description: 'A new version has been downloaded. Restart to apply.',
  //           duration: Infinity,
  //           action: {
  //             label: 'Restart Now',
  //             onClick: async () => {
  //               const { relaunch } = await import('@tauri-apps/plugin-process');
  //               await relaunch();
  //             },
  //           },
  //         });
  //       }
  //     } catch {}
  //   })();
  // }, []);

  if (!setupDone) {
    return <SetupScreen onReady={handleSetupReady} />;
  }

  // Blank while the status call is in flight — showing the sign-in form
  // first would make it flash for anyone already signed in.
  if (!authChecked) {
    return <div className="fixed inset-0" style={{ background: 'var(--color-bg)' }} />;
  }

  // Shown both for the initial gate and for "Add account" from the account
  // menu — the only difference is that adding can be cancelled.
  if (!authUser || addingAccount) {
    return (
      <AuthScreen
        hasAccount={addingAccount ? true : hasAccount}
        addingAccount={addingAccount}
        onCancel={addingAccount ? () => setAddingAccount(false) : undefined}
        onContinueAsGuest={() => setAuthUser(continueAsGuest())}
        onAuthenticated={(user) => {
          setAuthUser(user);
          setHasAccount(true);
          setAddingAccount(false);
        }}
      />
    );
  }

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<ChatPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="get-started" element={<GetStartedPage />} />
          <Route path="data-sources" element={<DataSourcesPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="logs" element={<LogsPage />} />
        </Route>
      </Routes>
      <Toaster position="bottom-right" />
      {commandPaletteOpen && <CommandPalette />}
    </>
  );
}
