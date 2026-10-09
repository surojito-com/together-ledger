/**
 * Mirrors the web client's `together-api-origin` meta tag (see `src/api.js`
 * at the repo root): the API origin is never hardcoded, and where it points
 * changes per environment rather than per code change.
 *
 * Expo inlines any `EXPO_PUBLIC_*` variable into the JS bundle at build
 * time, so `EXPO_PUBLIC_API_ORIGIN` is read from whichever `.env` file (or
 * EAS build profile) is active for that build — local, staging, or
 * production. See `apps/mobile/.env.example` and the mobile section of the
 * root README for how each environment sets it.
 *
 * The development fallback is the API server's own port (`PORT` in `server/config.js`, 4174), not
 * the static web server's (`scripts/dev.mjs`, 4173), which has no `/api/v1` (#283).
 */
const LOCAL_DEV_ORIGIN = 'http://localhost:4174';

export function apiOrigin(): string {
  const configured = process.env.EXPO_PUBLIC_API_ORIGIN?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (__DEV__) {
    return LOCAL_DEV_ORIGIN;
  }
  throw new Error(
    'EXPO_PUBLIC_API_ORIGIN is not set. Every non-development build must supply it explicitly.',
  );
}

export function apiBase(): string {
  return `${apiOrigin()}/api/v1`;
}
