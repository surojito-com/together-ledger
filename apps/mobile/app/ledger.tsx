import { EmptyState } from '../src/components/empty-state';
import { Screen } from '../src/components/ui';

/**
 * The ledger surface. The journey and its moments are TL-M-07 (#182); until then it says
 * plainly that they are not here yet, in the empty-state shape that screen will use too.
 */
export default function LedgerScreen() {
  return (
    <Screen title="Our ledger">
      <EmptyState title="Your ledger is not on this phone yet" body="Moments and threads arrive here in a coming build." />
    </Screen>
  );
}
