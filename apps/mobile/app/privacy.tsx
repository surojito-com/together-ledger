import policy from '../src/policies/privacy.json';
import { PolicyDocument } from '../src/components/policy-document';
import { Body, Screen } from '../src/components/ui';

/**
 * The privacy policy, on the phone itself. Both stores ask that it can be read from inside the
 * app, and Apple 3.1.2 asks each subscription offer to link to it (src/components/store-offers.tsx).
 * It is PRIVACY.md, generated into privacy.json by scripts/mobile-policies.mjs with the same
 * parse as the web's /privacy page, so the two never say different things. It is shown here
 * rather than opened in a browser, because the phone opens no web page (#268); a link in the
 * policy reads as its words. Reachable from Settings whether or not anyone is signed in.
 */
export default function PrivacyScreen() {
  return (
    <Screen title={policy.title}>
      <PolicyDocument blocks={policy.blocks} />
      <Body selectable>Questions about this policy, or a request about your data: legal@together-ledger.com.</Body>
    </Screen>
  );
}
