import tokens from './tokens.json';
import { resolveTheme, themeFor, type ThemeBase, type ThemeCatalog } from './resolve-theme';

/**
 * The four themes on the phone, read from tokens.json, which is generated from the web's
 * src/styles.css (scripts/mobile-theme-tokens.mjs). Change a colour there, never here.
 * Semantic roles only: there is no palette alias to borrow.
 */
export type ThemeColors = {
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  border: string;
  metaBg: string;
  onAccent: string;
  surface: string;
  surfaceElevated: string;
  textSecondary: string;
  focus: string;
  positive: string;
  caution: string;
  destructive: string;
  private: string;
  sharedNow: string;
  shareLater: string;
};

export type ThemeRadius = { xs: number; s: number; m: number; l: number; xl: number; pill: number };

export type Theme = {
  id: string;
  label: string;
  base: ThemeBase;
  colors: ThemeColors;
  radius: ThemeRadius;
};

const catalog: ThemeCatalog = tokens;

export const themes: readonly Theme[] = tokens.themes.map((theme) => ({
  id: theme.id,
  label: theme.label,
  base: theme.base === 'dark' ? 'dark' : 'light',
  colors: theme.colors,
  radius: tokens.radius,
}));

export function getTheme(requested: string | null | undefined): Theme {
  const id = resolveTheme(requested, catalog);
  return themes.find((theme) => theme.id === id) ?? themes[0];
}

export function chooseTheme(savedChoice: string | null | undefined, systemScheme: ThemeBase | null | undefined): Theme {
  return getTheme(themeFor(savedChoice, systemScheme, catalog));
}
