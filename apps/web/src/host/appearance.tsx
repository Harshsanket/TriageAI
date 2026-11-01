/**
 * Appearance preferences (Phase 20.7): theme, font size and motion are applied
 * as attributes on `<html>`; the inline script in index.html applies the cached
 * value before first paint and the server value wins once loaded.
 */
import { useEffect } from 'react';

import {
  AppearancePreferencesSchema,
  PreferencesResponseSchema,
  type AppearancePreferences,
} from '@triageai/contracts';

import { apiFetch } from './api';

export const APPEARANCE_STORAGE_KEY = 'triageai.appearance';

export function applyAppearance(preferences: AppearancePreferences): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const dark =
    preferences.theme === 'dark' ||
    (preferences.theme === 'auto' &&
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themeChoice = preferences.theme;
  root.dataset.fontSize = preferences.fontSize;
  const reduce =
    preferences.motion === 'off' ||
    (preferences.motion === 'auto' &&
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
  root.dataset.motion = reduce ? 'off' : 'on';
}

export function cachedAppearance(): AppearancePreferences | null {
  try {
    const raw = globalThis.localStorage?.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = AppearancePreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function cacheAppearance(preferences: AppearancePreferences): void {
  try {
    globalThis.localStorage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private mode: the inline script simply won't have a cached value.
  }
}

/** Apply cached values immediately, then load the server value (wins). */
export function useAppearanceSync(): void {
  useEffect(() => {
    const cached = cachedAppearance();
    if (cached) applyAppearance(cached);
    let disposed = false;
    void apiFetch<unknown>('/api/v1/me/preferences').then((result) => {
      if (disposed || !result.ok) return;
      const parsed = PreferencesResponseSchema.safeParse(result.data);
      if (!parsed.success) return;
      cacheAppearance(parsed.data.preferences);
      applyAppearance(parsed.data.preferences);
    });
    const themeMedia =
      typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const motionMedia =
      typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    const reapply = () => {
      const current = cachedAppearance();
      if (current) applyAppearance(current);
    };
    themeMedia?.addEventListener?.('change', reapply);
    motionMedia?.addEventListener?.('change', reapply);
    return () => {
      disposed = true;
      themeMedia?.removeEventListener?.('change', reapply);
      motionMedia?.removeEventListener?.('change', reapply);
    };
  }, []);
}
