import { Image, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Sign in with Google on an iPhone (#217). There is no Google SDK in the iOS app to draw Google's
 * own button (owner, Oct 9, 2026), so it is drawn here to Google's branding guidelines, from Google's
 * own sign-in assets (developers.google.com/identity/branding-guidelines, signin-assets.zip, iOS):
 * Google's "G" at 20 points, unaltered (assets/google-g.png, rendered from Google's SVG), Google's
 * words, and Google's colours for its light and dark buttons, not the theme's. Android draws
 * Google's native button instead (google-button.android.tsx), which Metro takes there.
 */
const GOOGLE_COLOURS = {
  light: { fill: '#FFFFFF', stroke: '#747775', text: '#1F1F1F' },
  dark: { fill: '#131314', stroke: '#8E918F', text: '#E3E3E3' },
} as const;

export function GoogleButton({ dark, disabled, onPress, style }: { dark: boolean; disabled: boolean; onPress: () => void; style: StyleProp<ViewStyle> }) {
  const colours = dark ? GOOGLE_COLOURS.dark : GOOGLE_COLOURS.light;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sign in with Google"
      accessibilityState={{ disabled, busy: disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, style, { backgroundColor: colours.fill, borderColor: colours.stroke, opacity: pressed || disabled ? 0.7 : 1 }]}
    >
      <Image source={require('../../assets/google-g.png')} style={styles.logo} accessibilityElementsHidden importantForAccessibility="no" />
      <Text style={[styles.label, { color: colours.text }]}>Sign in with Google</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16, borderWidth: 1, borderRadius: 24 },
  logo: { width: 20, height: 20 },
  label: { fontSize: 17, fontWeight: '500' },
});
