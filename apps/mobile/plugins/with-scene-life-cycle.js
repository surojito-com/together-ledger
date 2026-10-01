const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

/**
 * iOS 27 refuses to launch an app built with its SDK unless the app has adopted the scene life
 * cycle (#280): UIKit stops it at launch with "UIScene life cycle is required for apps built with
 * this SDK". Expo already ships the scene delegate (ExpoAppSceneDelegate, registered with UIKit as
 * EXExpoAppSceneDelegate), but its prebuild template still starts React Native from the app
 * delegate and declares no scenes. `ios/` is generated, so this makes both changes on every
 * prebuild. It can go once Expo's own template adopts scenes.
 */
const SCENE_DELEGATE = 'EXExpoAppSceneDelegate';

const START_IN_APP_DELEGATE = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (plist) => {
    plist.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: SCENE_DELEGATE },
        ],
      },
    };
    return plist;
  });
}

function withSceneStartedAppDelegate(config) {
  return withAppDelegate(config, (delegate) => {
    if (delegate.modResults.language !== 'swift') {
      throw new Error('with-scene-life-cycle expects the Swift AppDelegate from Expo’s template.');
    }
    let source = delegate.modResults.contents;
    // The scene delegate asks the app delegate for its React Native factory, then creates the
    // window from the connecting scene and starts React Native in it.
    if (!source.includes('ExpoReactNativeFactoryProvider')) {
      source = source.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    }
    source = source.replace(START_IN_APP_DELEGATE, '');
    // Fail the prebuild rather than ship an app that cannot open, if Expo's template moves.
    if (!source.includes('ExpoAppDelegate, ExpoReactNativeFactoryProvider') || source.includes('factory.startReactNative(')) {
      throw new Error('with-scene-life-cycle could not adopt the scene life cycle: Expo’s AppDelegate template has changed. See #280.');
    }
    delegate.modResults.contents = source;
    return delegate;
  });
}

module.exports = function withSceneLifeCycle(config) {
  return withSceneStartedAppDelegate(withSceneManifest(config));
};
