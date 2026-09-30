import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiBase } from '../config/api';
import { createAccountClient, type AccountClient, type AccountUser } from '../api/client';
import { secureTokenStore } from './token-storage';

type SessionState =
  | { status: 'loading'; user: null }
  | { status: 'signed-out'; user: null }
  | { status: 'signed-in'; user: AccountUser };

type SessionValue = SessionState & {
  client: AccountClient;
  /** Re-reads the account from the service, for example after verifying an email in the browser. */
  refresh: () => Promise<void>;
  setUser: (user: AccountUser | null) => void;
};

const SessionContext = createContext<SessionValue | null>(null);

const client = createAccountClient({ base: apiBase, fetch: (url, init) => fetch(url, init), tokens: secureTokenStore });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading', user: null });

  const setUser = useCallback((user: AccountUser | null) => {
    setState(user ? { status: 'signed-in', user } : { status: 'signed-out', user: null });
  }, []);

  // Offline, or no service in this build: keep whoever was signed in rather than signing them
  // out for a network problem. Only an explicit refusal clears the session.
  const settle = useCallback((result: Promise<AccountUser | null>) => result.then(setUser, (error) => {
    if ((error as { code?: string }).code === 'authentication_required') setUser(null);
    else setState((current) => (current.status === 'loading' ? { status: 'signed-out', user: null } : current));
  }), [setUser]);

  const refresh = useCallback(() => settle(client.session()), [settle]);

  // Restore whoever this phone last signed in as, from the tokens in its keychain.
  useEffect(() => {
    settle(client.session());
  }, [settle]);

  const value = useMemo<SessionValue>(() => ({ ...state, client, refresh, setUser }), [state, refresh, setUser]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
