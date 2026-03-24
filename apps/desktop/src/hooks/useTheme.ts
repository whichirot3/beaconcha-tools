import { useEffect, useState } from 'react';

export type Theme = 'studio_light' | 'graphite_dark';

const THEME_KEY = 'beaconops_theme';

function storageSafe(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readTheme(): Theme {
  const storage = storageSafe();
  const saved = storage?.getItem(THEME_KEY);
  if (saved === 'graphite_dark') {
    return 'graphite_dark';
  }
  return 'studio_light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    const datasetValue = theme === 'graphite_dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = datasetValue;
    const storage = storageSafe();
    storage?.setItem(THEME_KEY, theme);
  }, [theme]);

  return {
    theme,
    setTheme,
  };
}
