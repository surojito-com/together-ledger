import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { connectionChange } from './connection';

// Only whether the phone has a connection is watched. The library's extra check that the
// internet can be reached asks a Google address on iOS, and this app talks to nothing but its own
// service, so that check never runs.
NetInfo.configure({ reachabilityShouldRun: () => false });

type Handlers = {
  /** The phone lost its connection. */
  onOffline: () => void;
  /** The phone has a connection again, after it was known to be offline. */
  onOnline: () => void;
  /** The app came back from the background, and the phone is not known to be offline. */
  onForeground: () => void;
};

/**
 * Watches the connection (@react-native-community/netinfo, a native module) and the app coming
 * back to the foreground (#300, #352). The handlers are read when something happens, so they can
 * change between renders without the watch starting over.
 */
export function useConnectionWatch(handlers: Handlers) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    let connected: boolean | null = null;
    const stopWatchingConnection = NetInfo.addEventListener((state) => {
      const change = connectionChange(connected, state.isConnected);
      if (state.isConnected !== null) connected = state.isConnected;
      if (change === 'went-offline') latest.current.onOffline();
      if (change === 'came-back') latest.current.onOnline();
    });
    let appState = AppState.currentState;
    const appStateWatch = AppState.addEventListener('change', (next) => {
      if (next === 'active' && appState === 'background' && connected !== false) latest.current.onForeground();
      appState = next;
    });
    return () => {
      stopWatchingConnection();
      appStateWatch.remove();
    };
  }, []);
}
