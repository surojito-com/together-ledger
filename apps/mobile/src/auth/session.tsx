import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiBase } from '../config/api';
import { thisBuild } from '../config/build';
import { createAccountClient, type AccountClient, type AccountUser } from '../api/client';
import { sessionAnswered, sessionFailed, type SessionState } from './session-state';
import { secureTokenStore } from './token-storage';

type SessionValue = SessionState & {
  client: AccountClient;
  /** Re-reads the account from the service: after verifying an email in the browser, and when the connection or the app comes back. */
  refresh: () => Promise<void>;
  setUser: (user: AccountUser | null) => void;
};

const SessionContext = createContext<SessionValue | null>(null);

const client = createAccountClient({ base: apiBase, fetch: (url, init) => fetch(url, init), tokens: secureTokenStore, build: thisBuild.header });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading', user: null });

  const setUser = useCallback((user: AccountUser | null) => {
    setState(sessionAnswered(user));
  }, []);

  // Offline, or the service out of reach: keep whoever was signed in, and on opening the app
  // say the phone is offline rather than signed out (#352). Only an explicit refusal signs out.
  const settle = useCallback((result: Promise<AccountUser | null>) => result.then(setUser, (error) => {
    setState((current) => sessionFailed(current, error));
  }), [setUser]);

  const refresh = useCallback(() => settle(client.session()), [settle]);

  // Restore whoever this phone last signed in as, from the tokens in its keychain.
  useEffect(() => {
    settle(client.session());
  }, [settle]);

  // The service refused this phone's tokens (#194): its sign-in ended somewhere else, or ran
  // out. It is signed out here at once, whichever screen noticed. SignedOutWatch (app/_layout.tsx)
  // takes the person to sign in and says why.
  useEffect(() => client.onSignedOut(() => setState(sessionAnswered(null))), []);

  const value = useMemo<SessionValue>(() => ({ ...state, client, refresh, setUser }), [state, refresh, setUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
