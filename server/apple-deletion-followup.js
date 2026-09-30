import { PlatformError } from './platform.js';

// The owner's follow-up for an Apple account-deleted event that Delete account refused (#250).
// The person deleted their Apple ID, so they can never sign in to hand a journey over themselves;
// the owner does it for them within 30 days, then finishes the deletion. Everything goes through
// the app's own functions — transferOwnership, the billing check, deleteAccount — never raw SQL,
// so the result is exactly what the person would have got by doing it in the app.

const DAY_MS = 24 * 60 * 60 * 1000;

// Every refused deletion still waiting, oldest first, with the shared journeys holding it up and
// the people in them (by id, display name and when they joined), so the owner can choose who
// takes each journey over.
export async function listRefusedAppleDeletions(pool, now = new Date()) {
  const refused = await pool.query(
    `SELECT i.user_id, i.apple_account_deleted_at FROM user_identities i JOIN users u ON u.id=i.user_id
     WHERE i.provider='apple' AND i.apple_account_deleted_at IS NOT NULL AND u.deleted_at IS NULL
     ORDER BY i.apple_account_deleted_at`,
  );
  const waiting = [];
  for (const row of refused.rows) {
    const owned = await pool.query(
      `SELECT DISTINCT j.id, j.name, j.created_at FROM journeys j
       JOIN journey_members m ON m.journey_id=j.id AND m.user_id<>$1
       WHERE j.owner_user_id=$1 ORDER BY j.created_at`,
      [row.user_id],
    );
    const journeys = [];
    for (const journey of owned.rows) {
      const members = await pool.query(
        `SELECT m.user_id, u.display_name, m.joined_at FROM journey_members m JOIN users u ON u.id=m.user_id
         WHERE m.journey_id=$1 AND m.user_id<>$2 ORDER BY m.joined_at`,
        [journey.id, row.user_id],
      );
      journeys.push({
        journeyId: journey.id,
        name: journey.name,
        members: members.rows.map((member) => ({ userId: member.user_id, displayName: member.display_name, joinedAt: new Date(member.joined_at).toISOString() })),
      });
    }
    const refusedAt = new Date(row.apple_account_deleted_at);
    waiting.push({
      userId: row.user_id,
      refusedAt: refusedAt.toISOString(),
      daysWaiting: Math.floor((now.getTime() - refusedAt.getTime()) / DAY_MS),
      journeys,
    });
  }
  return waiting;
}

// handovers: [{ journeyId, toUserId }], one per shared journey the account still owns. Refuses
// anything that isn't a refused Apple deletion: an account that still has a password or another
// sign-in can delete itself, and that is its own choice to make.
export async function finishRefusedAppleDeletion({ pool, platform, billing }, userId, handovers = []) {
  const user = await pool.query('SELECT password_hash FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
  const identities = await pool.query('SELECT provider, apple_account_deleted_at FROM user_identities WHERE user_id=$1', [userId]);
  const refused = identities.rows.filter((row) => row.provider === 'apple' && row.apple_account_deleted_at);
  if (!user.rowCount || refused.length === 0) {
    throw new PlatformError(404, 'not_a_refused_apple_deletion', 'No refused Apple deletion is waiting for that account.');
  }
  if (user.rows[0].password_hash || identities.rowCount > refused.length) {
    throw new PlatformError(409, 'account_has_another_way_in', 'That account can still sign in another way, so it can delete itself.');
  }
  for (const { journeyId, toUserId } of handovers) {
    await platform.transferOwnership(userId, journeyId, toUserId);
  }
  await billing.assertAccountDeletable(userId);
  await platform.deleteAccount(userId, null);
  return { deleted: true, handedOver: handovers.length };
}
