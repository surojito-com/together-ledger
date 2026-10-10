import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MOMENT_VIEW, type MomentView } from '../storage/ledger-store';

type MomentViewContextValue = { view: MomentView; setView: (view: MomentView) => void };

const MomentViewContext = createContext<MomentViewContextValue | null>(null);

/**
 * How the ledger shows its moments (Oct 9): every card in full, or one short row each. Held for
 * the whole app, as the theme is, so the choice survives leaving the ledger and coming back;
 * `onViewChange` writes it to the phone (src/storage/use-stored-preferences.ts).
 */
export function MomentViewProvider({ initialView = DEFAULT_MOMENT_VIEW, onViewChange, children }: {
  initialView?: MomentView;
  onViewChange?: (view: MomentView) => void;
  children: ReactNode;
}) {
  const [view, setViewState] = useState<MomentView>(initialView);
  const value = useMemo<MomentViewContextValue>(() => ({
    view,
    setView: (next) => {
      setViewState(next);
      onViewChange?.(next);
    },
  }), [view, onViewChange]);
  return <MomentViewContext.Provider value={value}>{children}</MomentViewContext.Provider>;
}

export function useMomentView(): MomentViewContextValue {
  const value = useContext(MomentViewContext);
  if (!value) throw new Error('useMomentView must be used inside MomentViewProvider');
  return value;
}
