import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { chooseTheme, type Theme } from './themes';

type ThemeContextValue = {
  theme: Theme;
  /** The person's saved choice, or null while the phone's light/dark preference decides. */
  choice: string | null;
  /** Pass null to go back to following the phone. */
  setChoice: (themeId: string | null) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

type ThemeProviderProps = {
  /** The saved theme id, already settled from a retired one (src/storage/ledger-store.ts, #185). */
  initialChoice?: string | null;
  onChoiceChange?: (themeId: string | null) => void;
  children: ReactNode;
};

/**
 * Switches themes at runtime. With no saved choice it follows the phone, and changes the
 * moment the phone changes between light and dark.
 */
export function ThemeProvider({ initialChoice = null, onChoiceChange, children }: ThemeProviderProps) {
  const systemScheme = useColorScheme();
  const [choice, setChoiceState] = useState<string | null>(initialChoice);
  const value = useMemo<ThemeContextValue>(() => ({
    theme: chooseTheme(choice, systemScheme === 'dark' ? 'dark' : 'light'),
    choice,
    setChoice: (themeId) => {
      setChoiceState(themeId);
      onChoiceChange?.(themeId);
    },
  }), [choice, systemScheme, onChoiceChange]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
