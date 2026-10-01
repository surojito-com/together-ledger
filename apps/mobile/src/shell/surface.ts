/**
 * Which of the two top-level surfaces opens, ported from the web (src/app.js: setSurface,
 * showWelcomeSurface, showLedgerSurface). Someone who has begun their ledger goes straight to
 * it; everyone else meets the welcome first. Signing out does not change the answer.
 */
export type Surface = 'welcome' | 'ledger';

export function openingSurface(preferences: { onboardingComplete?: boolean } | null | undefined): Surface {
  return preferences?.onboardingComplete ? 'ledger' : 'welcome';
}

