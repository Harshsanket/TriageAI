import { afterEach, describe, expect, it } from 'vitest';

import { APPEARANCE_STORAGE_KEY, applyAppearance, cacheAppearance } from './appearance';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-font-size');
  document.documentElement.removeAttribute('data-motion');
  localStorage.removeItem(APPEARANCE_STORAGE_KEY);
});

describe('appearance tokens (phase 20.7)', () => {
  it('applies theme, font size and motion as root attributes', () => {
    applyAppearance({ theme: 'dark', fontSize: 'xlarge', motion: 'off' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.fontSize).toBe('xlarge');
    expect(document.documentElement.dataset.motion).toBe('off');
  });

  it('caches preferences for the pre-paint script', () => {
    cacheAppearance({ theme: 'light', fontSize: 'small', motion: 'on' });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toMatchObject({
      theme: 'light',
      fontSize: 'small',
      motion: 'on',
    });
  });
});
