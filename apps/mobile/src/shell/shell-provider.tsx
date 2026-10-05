import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { KEEP_LABEL, TOAST_MS } from './defaults';
import { clearStatus as clearFrom, closeDialog, showStatus as statusFor, type Status, type StatusTone } from './status';

export type DialogRequest = {
  /** 'consequence' is read before it is agreed to; 'plain' is everything else. */
  kind: 'consequence' | 'plain';
  title: string;
  message: string;
  confirmLabel: string;
  keepLabel: string;
  destructive: boolean;
  resolve: (confirmed: boolean) => void;
};

export type ConsequenceOptions = {
  title: string;
  /** What will happen, stated plainly. */
  consequence: string;
  /** Names the act ("Delete conversation"), never "OK". */
  confirmLabel: string;
  keepLabel?: string;
  /** Only for what cannot be undone. */
  destructive?: boolean;
};

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  keepLabel?: string;
  destructive?: boolean;
};

type ShellContextValue = {
  status: Status;
  showStatus: (message: string, options?: { tone?: StatusTone; source?: string }) => void;
  /** With a source, clears only that source's message; with none (Dismiss), clears whatever shows. */
  clearStatus: (source?: string) => void;
  showToast: (message: string) => void;
  /** Resolves true only when the person chose the named act. */
  confirmConsequence: (options: ConsequenceOptions) => Promise<boolean>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialogOpen: boolean;
  /** For ShellOverlays: the dialog showing, how it is answered, and the toast showing. */
  dialog: DialogRequest | null;
  answerDialog: (confirmed: boolean) => void;
  toast: { message: string; id: number } | null;
  onboardingComplete: boolean;
  /** Begin the ledger: from now on the ledger opens first (showLedgerSurface({ persist: true })). */
  completeOnboarding: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

type ShellProviderProps = {
  /** Kept in the phone's own ledger, preferences.onboardingComplete, as on the web (#185). */
  initialOnboardingComplete?: boolean;
  onOnboardingComplete?: () => void;
  children: ReactNode;
};

/**
 * The frame every screen hangs in (TL-M-06, #181): one status region, one dialog at a time,
 * one toast, and the rule for which surface opens. Ported from the web's src/app.js.
 * ShellOverlays draws the dialog and the toast above the screens.
 */
export function ShellProvider({ initialOnboardingComplete = false, onOnboardingComplete, children }: ShellProviderProps) {
  const [status, setStatus] = useState<Status>(null);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [toast, setToast] = useState<{ message: string; id: number } | null>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(initialOnboardingComplete);
  const dialogRef = useRef<DialogRequest | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showStatus = useCallback<ShellContextValue['showStatus']>((message, options = {}) => {
    setStatus(statusFor(message, { ...options, inDialog: dialogRef.current !== null }));
    // Android reads the region's live-region change; iOS has no live regions, so it is told.
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
  }, []);

  const clearStatus = useCallback<ShellContextValue['clearStatus']>((source) => {
    setStatus((current) => clearFrom(current, source));
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    const id = ++toastSeq.current;
    setToast({ message, id });
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
    // Only the newest toast may set the timer, even when Android answers out of order.
    const hide = (ms: number) => {
      if (toastSeq.current !== id) return;
      toastTimer.current = setTimeout(() => setToast(null), ms);
    };
    // Android lets a person ask for more time to read passing messages; honour it.
    if (Platform.OS === 'android') AccessibilityInfo.getRecommendedTimeoutMillis(TOAST_MS).then(hide, () => hide(TOAST_MS));
    else hide(TOAST_MS);
  }, []);

  const open = useCallback((request: Omit<DialogRequest, 'resolve'>) => new Promise<boolean>((resolve) => {
    // One dialog at a time: a second request answers the first with "keep".
    dialogRef.current?.resolve(false);
    const next = { ...request, resolve };
    dialogRef.current = next;
    setDialog(next);
  }), []);

  const close = useCallback((confirmed: boolean) => {
    const current = dialogRef.current;
    if (!current) return;
    dialogRef.current = null;
    setDialog(null);
    setStatus(closeDialog);
    current.resolve(confirmed);
  }, []);

  const value = useMemo<ShellContextValue>(() => ({
    status,
    showStatus,
    clearStatus,
    showToast,
    confirmConsequence: ({ title, consequence, confirmLabel, keepLabel = KEEP_LABEL, destructive = false }) =>
      open({ kind: 'consequence', title, message: consequence, confirmLabel, keepLabel, destructive }),
    confirm: ({ title, message, confirmLabel, keepLabel = 'Cancel', destructive = false }) =>
      open({ kind: 'plain', title, message, confirmLabel, keepLabel, destructive }),
    dialogOpen: dialog !== null,
    dialog,
    answerDialog: close,
    toast,
    onboardingComplete,
    completeOnboarding: () => {
      if (onboardingComplete) return;
      setOnboardingComplete(true);
      onOnboardingComplete?.();
    },
  }), [status, showStatus, clearStatus, showToast, open, close, dialog, toast, onboardingComplete, onOnboardingComplete]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside ShellProvider');
  return value;
}
