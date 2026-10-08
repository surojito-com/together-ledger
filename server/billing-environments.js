// Where paid room and paid photo and place slots are read from (#272): the web's environment and
// the stores'. On a live service, a sandbox purchase counts only for the accounts allowed to make
// one there (STORE_SANDBOX_ACCOUNT_IDS: App Review's sample account and the owner's own test
// accounts), and only for what that account itself paid for. Nobody else's sandbox purchase is
// ever read as live.
//
// Returns a SQL condition and its parameters, numbered from `from`, for a table whose rows carry
// an environment and the account that paid.
export function paidEnvironments(config, { environment = 'environment', payer = 'payer_user_id', from }) {
  const [web, store = web] = config.billingEnvironments || [config.stripeEnvironment];
  const testers = config.storeEnvironment === 'live' ? (config.storeSandboxAccountIds || []) : [];
  const own = `${environment} IN ($${from},$${from + 1})`;
  if (!testers.length) return { sql: own, params: [web, store] };
  const listed = testers.map((_, index) => `$${from + 2 + index}`).join(',');
  return { sql: `(${own} OR (${environment}='sandbox' AND ${payer} IN (${listed})))`, params: [web, store, ...testers] };
}
