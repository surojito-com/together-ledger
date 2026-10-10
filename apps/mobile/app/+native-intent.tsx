import { openedInvitation, INVITATION_PATH } from '../src/invitations/invitation-link';

/**
 * A link the phone was opened with, before the router reads it (#266). The only https link this
 * app claims is an invitation's (app.json: associatedDomains, intentFilters), and its code is after
 * the #, which the router would drop. It is handed to the invitation screen, which keeps it on this
 * phone; every other link goes on as it came.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  const code = openedInvitation(path);
  if (code === undefined) return path;
  return code ? `${INVITATION_PATH}?code=${encodeURIComponent(code)}` : INVITATION_PATH;
}
