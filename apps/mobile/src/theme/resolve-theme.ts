/**
 * Which theme a person gets, decided the same way the web decides it (src/themes.js):
 * a saved choice wins; a retired theme lands on the survivor closest to it, so a saved
 * `tokyo-night` becomes Dark rather than silently becoming Light; with no choice at all,
 * the phone's own light or dark preference decides.
 *
 * Kept free of imports so the theme gate can run it directly (tests/mobile-theme-gate.test.js).
 */
export type ThemeBase = 'light' | 'dark';

export type ThemeCatalog = {
  themes: readonly { id: string; base: string }[];
  retired: Readonly<Record<string, string>>;
};

export function resolveTheme(requested: string | null | undefined, catalog: ThemeCatalog): string {
  const known = (id: string | undefined) => Boolean(id && catalog.themes.some((theme) => theme.id === id));
  if (requested && known(requested)) return requested;
  const survivor = requested ? catalog.retired[requested] : undefined;
  return survivor && known(survivor) ? survivor : 'light';
}

/** A saved choice if there is one, otherwise the phone's preference. */
export function themeFor(
  savedChoice: string | null | undefined,
  systemScheme: ThemeBase | null | undefined,
  catalog: ThemeCatalog,
): string {
  return resolveTheme(savedChoice || (systemScheme === 'dark' ? 'dark' : 'light'), catalog);
}
