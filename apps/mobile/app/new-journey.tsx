import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Choices } from '../src/components/choices';
import { DateField } from '../src/components/date-field';
import { Body, Button, Field, Screen } from '../src/components/ui';
import { CREATED_MESSAGE, dateFieldsShown, END_DATE_CHOICES, journeyPayload, journeyProblem, LOCATION_LIMIT, NAME_LIMIT, newJourneyDraft, START_DATE_CHOICES, type JourneyDraft } from '../src/journey/journey-draft';
import type { Journey } from '../src/journey/journey-view';
import { useJourney } from '../src/journey/use-journey';
import { useShell } from '../src/shell/shell-provider';

/**
 * Begin a private journey: the web's #journey-dialog for a signed-in account (#333). The person
 * who begins it owns it, and it opens on the ledger as soon as it exists.
 */
export default function NewJourneyScreen() {
  const session = useSession();
  const journey = useJourney();
  const { showStatus, clearStatus, showToast } = useShell();
  const [draft, setDraft] = useState<JourneyDraft>(() => newJourneyDraft());
  const [pending, setPending] = useState(false);
  // A problem with this form leaves with it, as a problem raised in a web dialog does.
  useEffect(() => () => clearStatus('new-journey'), [clearStatus]);

  if (session.status !== 'signed-in') return <Screen title="Begin a shared journey"><Body>Sign in on this phone to begin a private journey.</Body></Screen>;

  const change = (next: Partial<JourneyDraft>) => setDraft((current) => ({ ...current, ...next }));
  const shown = dateFieldsShown(draft);

  const create = async () => {
    const problem = journeyProblem(draft);
    if (problem) {
      showStatus(problem, { source: 'new-journey' });
      return;
    }
    setPending(true);
    try {
      const created = await session.client.createJourney<Journey>(journeyPayload(draft));
      clearStatus('new-journey');
      await journey.open(created.id);
      showToast(CREATED_MESSAGE);
      router.back();
    } catch (error) {
      showStatus(accountMessage(error), { source: 'new-journey' });
    } finally {
      setPending(false);
    }
  };

  return (
    <Screen title="Begin a shared journey" lead="Begin with a name. The optional details can wait until they feel useful.">
      <Field label="Journey name" value={draft.name} onChangeText={(name) => change({ name })} maxLength={NAME_LIMIT} placeholder="e.g. Mountain weekend" />
      <Field label="Place or season (optional)" value={draft.location} onChangeText={(location) => change({ location })} maxLength={LOCATION_LIMIT} placeholder="Add this only if it helps you recognize the journey" />
      <Choices label="When it began" options={START_DATE_CHOICES} selected={draft.startDateStatus} onSelect={(startDateStatus) => change({ startDateStatus })} />
      {shown.startDate ? <DateField label="Exact start date" hint="Year, month and day, such as 2026-09-30." value={draft.startDate} onChange={(startDate) => change({ startDate })} /> : null}
      <Choices label="How long it lasts" options={END_DATE_CHOICES} selected={draft.endDateStatus} onSelect={(endDateStatus) => change({ endDateStatus })} />
      {shown.endDate ? <DateField label="Exact end date" hint="Year, month and day, such as 2026-09-30." value={draft.endDate} onChange={(endDate) => change({ endDate })} /> : null}
      <Button label="Create journey" pending={pending} pendingLabel="Creating journey…" disabled={!draft.name.trim()} onPress={create} />
    </Screen>
  );
}
