// One import per weight, never the package's main entry: that entry requires all eight
// Gelasio files, and every file it requires ships inside the app.
import { Gelasio_400Regular } from '@expo-google-fonts/gelasio/400Regular';
import { Gelasio_400Regular_Italic } from '@expo-google-fonts/gelasio/400Regular_Italic';
import { Gelasio_700Bold } from '@expo-google-fonts/gelasio/700Bold';

/**
 * The serif is Gelasio (SIL OFL 1.1), bundled, decided in #177 and
 * docs/2026-09-21-tl-m-02-font-decision.md. Interface text stays in the system sans, so it
 * has no entry here.
 *
 * Only these three files are loaded, so only these ship. Headings and moment titles render
 * at weight 400, not 500: Georgia rounded the web's 500 down to 400, and 400 is what the
 * design was drawn against.
 */
export const fontSources = {
  Gelasio_400Regular,
  Gelasio_400Regular_Italic,
  Gelasio_700Bold,
};

/**
 * React Native picks a weight by family name, not by fontWeight, on Android, so each weight
 * is its own family and fontWeight stays 'normal'.
 */
export const fonts = {
  serif: { fontFamily: 'Gelasio_400Regular', fontWeight: 'normal' },
  serifItalic: { fontFamily: 'Gelasio_400Regular_Italic', fontWeight: 'normal' },
  serifBold: { fontFamily: 'Gelasio_700Bold', fontWeight: 'normal' },
} as const;
