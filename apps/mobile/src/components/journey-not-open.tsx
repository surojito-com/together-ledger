import { useSession } from '../auth/session';
import { JOURNEYS_NOT_LOADED, offlineReason, opensWhenBack } from '../journey/journey-state';
import { useJourney } from '../journey/use-journey';
import { Body, Button, Screen } from './ui';

/**
 * A screen that needs the open journey (History, Journey sharing), while there is none to show
 * (#352). Offline it says it opens once the connection is back, never "Sign in" while signed in
 * and never an endless "Loading…"; a load that failed otherwise offers Try again.
 */
export function JourneyNotOpen({ title, signedOut, noJourneys }: { title: string; signedOut: string; noJourneys: string }) {
  const session = useSession();
  const journey = useJourney();
  const { state } = journey;
  const offline = offlineReason(state);
  if (offline || state.phase === 'failed') {
    return (
      <Screen title={title}>
        <Body>{offline ? opensWhenBack(title) : JOURNEYS_NOT_LOADED}</Body>
        <Button kind="quiet" label="Try again" onPress={state.phase === 'offline' ? session.refresh : journey.retry} />
      </Screen>
    );
  }
  const words = state.phase === 'signed-out' ? signedOut : state.phase === 'no-journeys' ? noJourneys : 'Loading…';
  return <Screen title={title}><Body>{words}</Body></Screen>;
}
