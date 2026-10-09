import { Platform } from 'react-native';
import { googleClientIdFor } from '../auth/social-sign-in';

/**
 * The Google client this build signs in with (#217), never written into the source. Expo inlines
 * `EXPO_PUBLIC_*` variables into the bundle at build time, from the EAS build profile
 * (apps/mobile/eas.json) or a local `.env.local`, so each is read here by its full name. Both are
 * public identifiers, not secrets. Unset, the phone offers no Google, and no Apple on an iPhone.
 *
 * - `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`: the iOS OAuth client. app.config.js also turns it into the
 *   URL scheme Google's sheet returns to.
 * - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`: the web client Android asks Google's token for, the same
 *   value as the server's `GOOGLE_WEB_CLIENT_ID`.
 */
export const googleConfig = {
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? null,
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? null,
};

export const phonePlatform = Platform.OS === 'ios' ? 'ios' : 'android';

export const googleClientId = googleClientIdFor(phonePlatform, googleConfig);
