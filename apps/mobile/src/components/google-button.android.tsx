import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import type { StyleProp, ViewStyle } from 'react-native';

/** Sign in with Google on Android (#217): Google's own native button. The iPhone's is google-button.tsx. */
export function GoogleButton({ dark, disabled, onPress, style }: { dark: boolean; disabled: boolean; onPress: () => void; style: StyleProp<ViewStyle> }) {
  return <GoogleSigninButton size={GoogleSigninButton.Size.Wide} color={dark ? 'dark' : 'light'} disabled={disabled} style={style} onPress={onPress} />;
}
