import { router } from 'expo-router';
import { accountMessage } from '../auth/account-messages';
import { useSession } from '../auth/session';
import { useShell } from '../shell/shell-provider';
import { deleteConsequence, payloadFrom, savedMessage, sharePayload, type Draft, type EditableMoment } from './moment-draft';
import { useJourney } from './use-journey';
import { useWaitingMoments } from './use-waiting-moments';
import { KEPT_ON_PHONE } from './waiting-moments';

const SHARE_NOW = {
  title: 'Share this moment now?',
  consequence: 'Everyone in this journey will be able to see it, including anyone who joins later. That access cannot be undone.',
  confirmLabel: 'Share this moment',
};

/**
 * Holding, changing, sharing and deleting a moment (TL-M-08, #183). Each one asks the server,
 * which stays the authority, and then re-reads the journey. A refusal (a conflict, a place that
 * needs its add-on) goes to the status region and leaves the form as it was.
 *
 * Holding a new moment is the one change that can wait (#352): when the service cannot be
 * reached, it is kept on this phone and sent once the connection returns
 * (src/journey/use-waiting-moments.ts). Changing, sharing and deleting still need the connection,
 * and offline they are refused and leave the form as it was.
 */
export function useMomentActions() {
  const { client } = useSession();
  const shell = useShell();
  const journey = useJourney();
  const waiting = useWaitingMoments();
  const journeyId = journey.state.phase === 'ready' ? journey.state.activeId : null;

  async function attempt(work: () => Promise<void>) {
    shell.clearStatus('moment');
    try {
      await work();
      return true;
    } catch (error) {
      shell.showStatus(accountMessage(error), { source: 'moment' });
      return false;
    }
  }

  return {
    journeyId,
    /**
     * Save the form. Turning an existing moment shared asks first, as sharing it from the ledger
     * does, because that access cannot be taken back.
     */
    async save(draft: Draft, before: EditableMoment | null) {
      if (!journeyId) return false;
      if (before && before.visibility !== 'shared-now' && draft.visibility === 'shared-now' && !await shell.confirmConsequence(SHARE_NOW)) return false;
      const payload = payloadFrom(draft, before);
      if (!before) {
        const journeyName = journey.state.phase === 'ready' ? journey.state.snapshot.journey.name : '';
        shell.clearStatus('moment');
        const held = await waiting.hold(journeyId, journeyName, payload).catch((error: unknown) => {
          shell.showStatus(accountMessage(error), { source: 'moment' });
          return null;
        });
        if (!held) return false;
        if (held === 'waiting') {
          router.back();
          shell.showToast(KEPT_ON_PHONE);
          return true;
        }
      } else if (!await attempt(() => client.updateMoment(journeyId, before.id, payload).then(() => undefined))) {
        return false;
      }
      await journey.reload();
      router.back();
      shell.showToast(savedMessage(before, draft.visibility));
      return true;
    },
    /** The web's shareMoment(): a share-later moment, shared now, after its consequence is read. */
    async share(moment: EditableMoment) {
      if (!journeyId || moment.visibility !== 'share-later') return;
      if (!await shell.confirmConsequence(SHARE_NOW)) return;
      if (!await attempt(() => client.updateMoment(journeyId, moment.id, sharePayload(moment)).then(() => undefined))) return;
      await journey.reload();
      shell.showToast('Moment shared with your journeyer.');
    },
    async remove(moment: EditableMoment) {
      if (!journeyId) return;
      if (!await shell.confirmConsequence({ title: 'Delete this moment?', consequence: deleteConsequence(moment), confirmLabel: 'Delete moment', destructive: true })) return;
      if (!await attempt(() => client.deleteMoment(journeyId, moment.id, moment.version))) return;
      await journey.reload();
      router.back();
      shell.showToast('Moment deleted.');
    },
  };
}
