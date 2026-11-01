/** Per-user UI preferences that are not appearance (Phase 20.7 store). */
import { useEffect, useState } from 'react';

import { PreferencesResponseSchema } from '@triageai/contracts';

import { apiFetch } from './api';

/**
 * Remembers whether the home page shows the conversation-history sidebar.
 * Default is off: the landing page stays the minimal composer.
 */
export function useChatSidebarPreference(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpenState] = useState(false);

  useEffect(() => {
    let disposed = false;
    void apiFetch<unknown>('/api/v1/me/preferences').then((result) => {
      if (disposed || !result.ok) return;
      const parsed = PreferencesResponseSchema.safeParse(result.data);
      if (parsed.success) setOpenState(parsed.data.preferences.chatSidebar);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const setOpen = (next: boolean) => {
    setOpenState(next);
    void apiFetch('/api/v1/me/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatSidebar: next }),
    });
  };

  return { open, setOpen };
}
