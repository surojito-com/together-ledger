// Leaving a journey (#96): what the web (src/app.js) and the phone
// (apps/mobile/app/journey-settings.tsx) both say, so the two never say different things. The
// words are for the owner to approve. Leaving can't be undone, so it lives in its own danger zone
// in the destructive colour, and takes two deliberate steps: the consequence dialog, then LEAVE
// typed in full. Nobody is removed: a person leaves.
//
// Kept free of imports, so either client loads it as it is. The phone reaches this file, so it
// names no price and no way to pay on the web (#268).

/** Typed to leave, as DELETE is typed to delete an account. The server checks it too. */
export const LEAVE_WORD = 'LEAVE';

export const LEAVE_ZONE_TITLE = 'Leave this journey';

export const LEAVE_ZONE_NOTE = 'Leaving is yours to decide. Nobody else has to agree, and nobody is asked. It can’t be undone: to come back, you would need a new invitation that everyone here agrees to.';

/** For the owner while anyone else is here: there is no Leave button until it is handed over. */
export const LEAVE_OWNER_FIRST = 'You hold this journey for everyone in it, so you can’t leave it yet. Make someone else here the owner first, under Journey record. Then you can leave.';

/** For the owner's approval (#96). */
export const LEAVE_SAFETY = 'If someone keeps contacting you after you leave, write to ledger-support@together-ledger.com. Together Ledger is not an emergency service; if you are in danger, call your local emergency number.';

export const LEAVE_START_LABEL = 'Leave this journey';
export const LEAVE_FIELD_LABEL = `Type ${LEAVE_WORD}`;
export const LEAVE_FIELD_HINT = `This is the last step. Nothing happens until you type ${LEAVE_WORD} and press Leave this journey now.`;
export const LEAVE_CONFIRM_LABEL = 'Leave this journey now';
export const LEAVE_PENDING_LABEL = 'Leaving…';
export const LEAVE_STAY_LABEL = 'Stay in this journey';

/** A store subscription neither stops leaving nor ends with it; the delete-account screen says the same of deleting. */
export const LEAVE_STORE_SUBSCRIPTION = 'Room you pay for in the App Store or Google Play stays with this journey, and leaving doesn’t cancel it. Cancel it with Apple or Google, or it keeps renewing.';

/** Account deletion's rule, for this journey (server/billing.js, assertJourneyLeavable). */
export const LEAVE_WAITS_ON_WEB_PAYMENT = 'If you pay on the web for room in this journey, that payment has to end first.';

/** Step one: what happens, said plainly, before anything is typed. */
export function leaveConsequence(journeyName) {
  return {
    title: `Leave “${journeyName}”?`,
    consequence: [
      'Your private moments here, and those you were keeping to share later, are deleted with their places and photos.',
      'Moments you shared stay with the others, still showing that you held them.',
      'Any proposal you made or invitation you sent that is still waiting is withdrawn.',
      'The journey’s History records that you left, and when. Nobody is sent an email or a notification.',
      LEAVE_WAITS_ON_WEB_PAYMENT,
      LEAVE_STORE_SUBSCRIPTION,
    ].join(' '),
    confirmLabel: 'Continue',
  };
}

/** Where the person lands, on the next journey or the empty start. */
export function leftJourney(journeyName) {
  return `You have left “${journeyName}”. It is no longer among your journeys.`;
}

/** Leave is offered to anyone but the owner, and never in a journey of one: there is nobody to leave it to. */
export function leaveOffer({ role, peopleHere }) {
  if (peopleHere < 2) return 'none';
  return role === 'owner' ? 'hand-over-first' : 'leave';
}

/**
 * A refusal that only means "not yet" (a payment to end, the journey to hand over) is a caution,
 * never the destructive colour: waiting and paying are not failures. Anything else is a problem.
 */
export function leaveRefusalTone(code) {
  return ['billing_subscription_active', 'ownership_transfer_required', 'journey_of_one'].includes(code) ? 'caution' : 'problem';
}
