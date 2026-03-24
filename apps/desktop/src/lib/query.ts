export function getSafeQueryParam(name: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return new URL(window.location.href).searchParams.get(name);
  } catch {
    try {
      return new URLSearchParams(window.location.search || '').get(name);
    } catch {
      return null;
    }
  }
}
