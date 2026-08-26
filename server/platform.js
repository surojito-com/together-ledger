import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import {
  assertPassword,
  csrfForSession,
  eventHmac,
  hashPassword,
  normalizeEmail,
  opaqueToken,
  sha256,
  verifyPassword,
} from './security.js';

export class PlatformError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new PlatformError(404, 'not_found', 'The requested record was not found.');
const forbidden = () => new PlatformError(403, 'forbidden', 'You do not have access to this journey.');
const CATEGORIES = new Set(['Flights', 'Hotel', 'Restaurants', 'Transportation', 'Activities', 'Shopping', 'Other']);
const STATUSES = new Set(['paid', 'due']);
const CONCERN_STATUSES = new Set(['open', 'resolved']);
const MOMENT_KINDS = new Set(['promise', 'acknowledgment', 'trigger', 'missed-chance', 'heart-to-heart', 'memory', 'feeling', 'boundary', 'repair-request', 'learned-something', 'call-me', 'called-you', 'practical-matter', 'other']);
const MONEY_CURRENCIES = new Set(['', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR']);
const START_DATE_STATUSES = new Set(['exact', 'unknown']);
const END_DATE_STATUSES = new Set(['date', 'unsure', 'forever']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new PlatformError(400, 'invalid_input', `${label} is required and must be ${max} characters or fewer.`);
  return text;
}

function cleanOptionalText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanEmail(value) {
  try { return normalizeEmail(value); } catch { throw new PlatformError(400, 'invalid_input', 'Enter a valid email address.'); }
}

function cleanUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,29}$/.test(username) || username.includes('--') || username.endsWith('-')) {
    throw new PlatformError(400, 'invalid_username', 'Choose 3–30 lowercase letters, numbers, or single hyphens. Start with a letter.');
  }
  return username;
}

function cleanLoginIdentifier(value) {
  const identifier = String(value || '').trim();
  return identifier.includes('@') ? cleanEmail(identifier) : cleanUsername(identifier);
}

async function cleanPasswordHash(value) {
  try { return await hashPassword(value); } catch { throw new PlatformError(400, 'invalid_input', 'Use a password between 12 and 128 characters.'); }
}

function dateTime(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email_normalized,
    username: row.username,
    displayName: row.display_name,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: dateTime(row.created_at),
  };
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value || '');
  const iso = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10);
}

function publicJourney(row) {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    startDate: dateOnly(row.start_date),
    startDateStatus: row.start_date_status || 'exact',
    endDate: dateOnly(row.end_date),
    endDateStatus: row.end_date_status || 'date',
    budgetCents: row.budget_cents,
    version: row.version,
    role: row.role,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
  };
}

function publicInvitation(row, now) {
  const acceptedAt = dateTime(row.accepted_at);
  const revokedAt = dateTime(row.revoked_at);
  const expiresAt = dateTime(row.expires_at);
  const status = acceptedAt ? 'accepted' : revokedAt ? 'revoked' : new Date(row.expires_at) <= now ? 'expired' : 'pending';
  return {
    id: row.id,
    email: row.email_normalized,
    invitedByUserId: row.invited_by_user_id,
    invitedByDisplayName: row.invited_by_display_name || 'Journey member',
    status,
    sentAt: dateTime(row.created_at),
    expiresAt,
    acceptedAt,
    revokedAt,
  };
}

function publicExpense(row) {
  return {
    id: row.id,
    journeyId: row.journey_id,
    merchant: row.merchant,
    category: row.category,
    amountCents: row.amount_cents,
    occurredOn: dateOnly(row.occurred_on),
    paidByUserId: row.paid_by_user_id,
    payerLabel: row.payer_label,
    account: row.account,
    status: row.status,
    reference: row.reference,
    notes: row.notes,
    version: row.version,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
  };
}

function auditExpense(expense) {
  if (!expense) return null;
  const { account: _account, reference: _reference, notes: _notes, payerLabel: _payerLabel, ...safe } = expense;
  return safe;
}

function publicConcern(row) {
  return {
    id: row.id,
    journeyId: row.journey_id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    version: row.version,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
  };
}

function publicMoment(row) {
  return {
    id: row.id,
    journeyId: row.journey_id,
    kind: row.kind,
    kindLabel: row.kind_label,
    occurredOn: dateOnly(row.occurred_on),
    title: row.title,
    detail: row.detail,
    visibility: row.visibility,
    moneyCents: row.money_cents,
    moneyCurrency: row.money_currency || '',
    createdBy: row.created_by_name || 'Journey member',
    updatedBy: row.updated_by_name || row.created_by_name || 'Journey member',
    shapedByBoth: Boolean(row.created_by_user_id && row.updated_by_user_id && row.created_by_user_id !== row.updated_by_user_id),
    version: row.version,
    createdAt: dateTime(row.created_at),
    updatedAt: dateTime(row.updated_at),
  };
}

function auditMoment(moment) {
  if (!moment) return null;
  const { detail: _detail, ...safe } = moment;
  return safe;
}

function cleanMoment(input, existing = null) {
  const kind = input.kind ?? existing?.kind;
  if (!MOMENT_KINDS.has(kind)) throw new PlatformError(400, 'invalid_input', 'Choose a valid kind of moment.');
  const kindLabel = kind === 'other'
    ? cleanText(input.kindLabel ?? existing?.kindLabel, 'A name for this kind of moment', 60)
    : '';
  const occurredOn = input.occurredOn ?? existing?.occurredOn;
  if (!DATE_PATTERN.test(occurredOn || '')) throw new PlatformError(400, 'invalid_input', 'Choose a valid moment date.');
  const moneyValue = Object.hasOwn(input, 'moneyCents') ? input.moneyCents : existing?.moneyCents;
  const moneyCents = moneyValue == null || moneyValue === '' ? null : Number(moneyValue);
  if (moneyCents != null && (!Number.isSafeInteger(moneyCents) || moneyCents < 0 || moneyCents > 100000000)) throw new PlatformError(400, 'invalid_input', 'Enter a valid optional money context.');
  const moneyCurrency = String(input.moneyCurrency ?? existing?.moneyCurrency ?? '').trim().toUpperCase();
  if (!MONEY_CURRENCIES.has(moneyCurrency)) throw new PlatformError(400, 'invalid_input', 'Choose a supported optional currency.');
  return {
    kind,
    kindLabel,
    occurredOn,
    title: cleanText(input.title ?? existing?.title, 'Moment title', 120),
    detail: String(input.detail ?? existing?.detail ?? '').slice(0, 1200),
    moneyCents,
    moneyCurrency,
  };
}

function cleanJourneyDetails(input, existing = null) {
  const startDateStatus = input.startDateStatus ?? existing?.startDateStatus ?? 'exact';
  const endDateStatus = input.endDateStatus ?? existing?.endDateStatus ?? 'date';
  if (!START_DATE_STATUSES.has(startDateStatus) || !END_DATE_STATUSES.has(endDateStatus)) throw new PlatformError(400, 'invalid_input', 'Choose valid date options.');
  const suppliedStartDate = Object.hasOwn(input, 'startDate') ? input.startDate : existing?.startDate;
  const suppliedEndDate = Object.hasOwn(input, 'endDate') ? input.endDate : existing?.endDate;
  const startDate = startDateStatus === 'exact' ? (suppliedStartDate ?? '') : null;
  const endDate = endDateStatus === 'date' ? (suppliedEndDate ?? '') : null;
  if (startDateStatus === 'exact' && !DATE_PATTERN.test(startDate)) throw new PlatformError(400, 'invalid_input', 'Choose a start date or select “I don’t remember exactly.”');
  if (endDateStatus === 'date' && !DATE_PATTERN.test(endDate)) throw new PlatformError(400, 'invalid_input', 'Choose an end date or select another ending.');
  if (startDate && endDate && endDate < startDate) throw new PlatformError(400, 'invalid_input', 'The end date must be on or after the start date.');
  return { startDateStatus, endDateStatus, startDate, endDate };
}

function publicEvent(row) {
  return {
    id: row.id,
    sequence: row.sequence,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    before: row.before_value,
    after: row.after_value,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export class PlatformService {
  constructor({ pool, config, mailer, now = () => new Date(), onDeliveryFailure = () => {} }) {
    this.pool = pool;
    this.config = config;
    this.mailer = mailer;
    this.now = now;
    this.onDeliveryFailure = onDeliveryFailure;
    this.dummyPasswordHash = hashPassword('invalid-login-padding'.padEnd(20, 'x'));
  }

  async deliver(kind, operation) {
    try {
      await operation();
      return true;
    } catch (error) {
      this.onDeliveryFailure({ kind, errorName: error?.name || 'Error' });
      return false;
    }
  }

  async ready() {
    await this.pool.query('SELECT 1');
  }

  async createSession(client, userId) {
    const rawToken = opaqueToken();
    const csrfToken = csrfForSession(this.config.SESSION_SECRET, rawToken);
    const expiresAt = new Date(this.now().getTime() + this.config.SESSION_HOURS * 60 * 60 * 1000);
    await client.query(
      'INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), userId, sha256(rawToken), sha256(csrfToken), expiresAt],
    );
    return { rawToken, csrfToken, expiresAt };
  }

  async register({ email, username, password }, accountOrigin) {
    const normalizedEmail = cleanEmail(email);
    const privateUsername = cleanUsername(username);
    const name = privateUsername;
    const passwordHash = await cleanPasswordHash(password);
    const verificationToken = opaqueToken();
    let result;
    try {
      result = await withTransaction(this.pool, async (client) => {
        const userId = randomUUID();
        const created = await client.query(
          'INSERT INTO users (id,email_normalized,username,display_name,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [userId, normalizedEmail, privateUsername, name, passwordHash],
        );
        await client.query(
          'INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), userId, 'email_verification', sha256(verificationToken), new Date(this.now().getTime() + this.config.TOKEN_MINUTES * 60 * 1000)],
        );
        return { user: publicUser(created.rows[0]), session: await this.createSession(client, userId) };
      });
    } catch (error) {
      if (error.code === '23505') throw new PlatformError(409, 'account_exists', 'That email or username is already in use.');
      throw error;
    }
    result.verificationSent = await this.deliver('verification', () => this.mailer.sendVerification({ to: normalizedEmail, token: verificationToken, accountOrigin }));
    return result;
  }

  async verifyEmail(token) {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query(
        `SELECT * FROM account_tokens WHERE purpose='email_verification' AND token_hash=$1 AND consumed_at IS NULL AND expires_at > $2 FOR UPDATE`,
        [sha256(token), this.now()],
      );
      if (!found.rowCount) throw new PlatformError(400, 'invalid_token', 'This verification link is invalid or expired.');
      await client.query('UPDATE account_tokens SET consumed_at=$1 WHERE id=$2', [this.now(), found.rows[0].id]);
      const updated = await client.query('UPDATE users SET email_verified_at=$1 WHERE id=$2 RETURNING *', [this.now(), found.rows[0].user_id]);
      return publicUser(updated.rows[0]);
    });
  }

  async resendVerification(userId, accountOrigin) {
    const user = await this.pool.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
    if (!user.rowCount || user.rows[0].email_verified_at) return;
    const token = opaqueToken();
    await withTransaction(this.pool, async (client) => {
      await client.query(`UPDATE account_tokens SET consumed_at=$1 WHERE user_id=$2 AND purpose='email_verification' AND consumed_at IS NULL`, [this.now(), userId]);
      await client.query(
        `INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at) VALUES ($1,$2,'email_verification',$3,$4)`,
        [randomUUID(), userId, sha256(token), new Date(this.now().getTime() + this.config.TOKEN_MINUTES * 60 * 1000)],
      );
    });
    return this.deliver('verification', () => this.mailer.sendVerification({ to: user.rows[0].email_normalized, token, accountOrigin }));
  }

  async login({ identifier, password }) {
    const normalizedIdentifier = cleanLoginIdentifier(identifier);
    const found = await this.pool.query('SELECT * FROM users WHERE (email_normalized=$1 OR username=$1) AND deleted_at IS NULL', [normalizedIdentifier]);
    const candidateHash = found.rows[0]?.password_hash || await this.dummyPasswordHash;
    const passwordMatches = await verifyPassword(candidateHash, password);
    const valid = Boolean(found.rowCount && passwordMatches);
    if (!valid) throw new PlatformError(401, 'invalid_credentials', 'Username, email, or password is incorrect.');
    const session = await withTransaction(this.pool, (client) => this.createSession(client, found.rows[0].id));
    return { user: publicUser(found.rows[0]), session };
  }

  async session(rawToken) {
    if (!rawToken) return null;
    const found = await this.pool.query(
      `SELECT s.*,u.email_normalized,u.username,u.display_name,u.email_verified_at,u.created_at,u.deleted_at
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.deleted_at IS NULL`,
      [sha256(rawToken), this.now()],
    );
    if (!found.rowCount) return null;
    const row = found.rows[0];
    const csrfToken = csrfForSession(this.config.SESSION_SECRET, rawToken);
    if (sha256(csrfToken) !== row.csrf_hash) return null;
    return { id: row.id, userId: row.user_id, csrfToken, user: publicUser({ ...row, id: row.user_id }) };
  }

  async logout(rawToken) {
    if (rawToken) await this.pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(rawToken)]);
  }

  async requestRecovery(email, accountOrigin) {
    let normalizedEmail;
    try { normalizedEmail = normalizeEmail(email); } catch { return; }
    const user = await this.pool.query('SELECT * FROM users WHERE email_normalized=$1 AND deleted_at IS NULL', [normalizedEmail]);
    if (!user.rowCount) return;
    const token = opaqueToken();
    await withTransaction(this.pool, async (client) => {
      await client.query(`UPDATE account_tokens SET consumed_at=$1 WHERE user_id=$2 AND purpose='password_recovery' AND consumed_at IS NULL`, [this.now(), user.rows[0].id]);
      await client.query(
        'INSERT INTO account_tokens (id,user_id,purpose,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), user.rows[0].id, 'password_recovery', sha256(token), new Date(this.now().getTime() + this.config.TOKEN_MINUTES * 60 * 1000)],
      );
    });
    await this.deliver('recovery', () => this.mailer.sendRecovery({ to: normalizedEmail, token, accountOrigin }));
  }

  async confirmRecovery({ token, password }) {
    const passwordHash = await cleanPasswordHash(password);
    return withTransaction(this.pool, async (client) => {
      const found = await client.query(
        `SELECT * FROM account_tokens WHERE purpose='password_recovery' AND token_hash=$1 AND consumed_at IS NULL AND expires_at>$2 FOR UPDATE`,
        [sha256(token), this.now()],
      );
      if (!found.rowCount) throw new PlatformError(400, 'invalid_token', 'This recovery link is invalid or expired.');
      await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, found.rows[0].user_id]);
      await client.query('UPDATE account_tokens SET consumed_at=$1 WHERE id=$2', [this.now(), found.rows[0].id]);
      await client.query('DELETE FROM sessions WHERE user_id=$1', [found.rows[0].user_id]);
    });
  }

  async requireMember(client, userId, journeyId, { owner = false } = {}) {
    const membership = await client.query(
      `SELECT jm.role,j.* FROM journey_members jm JOIN journeys j ON j.id=jm.journey_id
       WHERE jm.journey_id=$1 AND jm.user_id=$2`,
      [journeyId, userId],
    );
    if (!membership.rowCount) throw forbidden();
    if (owner && membership.rows[0].role !== 'owner') throw forbidden();
    return membership.rows[0];
  }

  async appendEvent(client, { journeyId, actorUserId, action, entityType, entityId, summary, before = null, after = null }) {
    if (this.config.NODE_ENV !== 'test') await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [journeyId]);
    const previous = await client.query('SELECT sequence,event_hash FROM journey_events WHERE journey_id=$1 ORDER BY sequence DESC LIMIT 1', [journeyId]);
    const sequence = (previous.rows[0]?.sequence || 0) + 1;
    const createdAt = this.now().toISOString();
    const previousHash = previous.rows[0]?.event_hash || '0'.repeat(64);
    const event = { journeyId, sequence, actorUserId, action, entityType, entityId: String(entityId), summary, before, after, previousHash, createdAt };
    const eventHash = eventHmac(this.config.AUDIT_HMAC_KEY, event);
    const id = randomUUID();
    await client.query(
      `INSERT INTO journey_events (id,journey_id,sequence,actor_user_id,action,entity_type,entity_id,summary,before_value,after_value,previous_hash,event_hash,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, journeyId, sequence, actorUserId, action, entityType, String(entityId), summary, before, after, previousHash, eventHash, createdAt],
    );
    return { id, ...event, eventHash };
  }

  async lockJourney(client, journeyId) {
    if (this.config.NODE_ENV !== 'test') await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [journeyId]);
  }

  async listJourneys(userId) {
    const result = await this.pool.query(
      `SELECT j.*,jm.role FROM journeys j JOIN journey_members jm ON jm.journey_id=j.id WHERE jm.user_id=$1 ORDER BY j.updated_at DESC`,
      [userId],
    );
    return result.rows.map(publicJourney);
  }

  async createJourney(userId, input) {
    const name = cleanText(input.name, 'Journey name', 80);
    const location = cleanOptionalText(input.location, 80);
    const budgetCents = Number(input.budgetCents);
    if (!Number.isSafeInteger(budgetCents) || budgetCents < 0 || budgetCents > 100000000) throw new PlatformError(400, 'invalid_input', 'Enter a valid budget.');
    const dates = cleanJourneyDetails(input);
    return withTransaction(this.pool, async (client) => {
      const id = randomUUID();
      const created = await client.query(
        `INSERT INTO journeys (id,owner_user_id,name,location,start_date,start_date_status,end_date,end_date_status,budget_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, userId, name, location, dates.startDate, dates.startDateStatus, dates.endDate, dates.endDateStatus, budgetCents],
      );
      await client.query(`INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'owner')`, [id, userId]);
      await this.appendEvent(client, { journeyId: id, actorUserId: userId, action: 'journey_created', entityType: 'journey', entityId: id, summary: `Created journey: ${name}`, after: publicJourney({ ...created.rows[0], role: 'owner' }) });
      return publicJourney({ ...created.rows[0], role: 'owner' });
    });
  }

  async updateJourney(userId, journeyId, input) {
    return withTransaction(this.pool, async (client) => {
      const existing = await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      if (Number(input.version) !== existing.version) throw new PlatformError(409, 'conflict', 'This journey changed on another device. Refresh before saving.');
      const next = {
        name: cleanText(input.name ?? existing.name, 'Journey name', 80),
        location: cleanOptionalText(input.location ?? existing.location, 80),
        budgetCents: input.budgetCents ?? existing.budget_cents,
      };
      const dates = cleanJourneyDetails(input, { startDateStatus: existing.start_date_status, endDateStatus: existing.end_date_status, startDate: dateOnly(existing.start_date), endDate: dateOnly(existing.end_date) });
      if (!Number.isSafeInteger(Number(next.budgetCents)) || Number(next.budgetCents) < 0 || Number(next.budgetCents) > 100000000) throw new PlatformError(400, 'invalid_input', 'Journey details are not valid.');
      const updated = await client.query(
        `UPDATE journeys SET name=$1,location=$2,start_date=$3,start_date_status=$4,end_date=$5,end_date_status=$6,budget_cents=$7,version=version+1,updated_at=$8 WHERE id=$9 AND version=$10 RETURNING *`,
        [next.name, next.location, dates.startDate, dates.startDateStatus, dates.endDate, dates.endDateStatus, Number(next.budgetCents), this.now(), journeyId, existing.version],
      );
      if (!updated.rowCount) throw new PlatformError(409, 'conflict', 'This journey changed on another device.');
      const before = publicJourney(existing);
      const after = publicJourney({ ...updated.rows[0], role: existing.role });
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'journey_updated', entityType: 'journey', entityId: journeyId, summary: `Updated journey: ${after.name}`, before, after });
      return after;
    });
  }

  async createInvitation(userId, journeyId, email, accountOrigin) {
    const emailNormalized = cleanEmail(email);
    const token = opaqueToken();
    await withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId, { owner: true });
      await this.lockJourney(client, journeyId);
      const capacity = await client.query('SELECT count(*)::int AS count FROM journey_members WHERE journey_id=$1', [journeyId]);
      if (Number(capacity.rows[0].count) >= 2) throw new PlatformError(409, 'journey_full', 'This journey already has two members.');
      await client.query('UPDATE invitations SET revoked_at=$1 WHERE journey_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [this.now(), journeyId]);
      await client.query(
        `INSERT INTO invitations (id,journey_id,invited_by_user_id,email_normalized,token_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), journeyId, userId, emailNormalized, sha256(token), new Date(this.now().getTime() + this.config.TOKEN_MINUTES * 60 * 1000)],
      );
    });
    const delivered = await this.deliver('invitation', () => this.mailer.sendInvitation({ to: emailNormalized, journeyId, token, accountOrigin }));
    if (!delivered) {
      await this.pool.query('UPDATE invitations SET revoked_at=$1 WHERE token_hash=$2 AND accepted_at IS NULL', [this.now(), sha256(token)]);
      throw new PlatformError(503, 'delivery_unavailable', 'The invitation could not be delivered. Try again later.');
    }
  }

  async acceptInvitation(userId, rawToken) {
    return withTransaction(this.pool, async (client) => {
      const user = await client.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
      if (!user.rowCount || !user.rows[0].email_verified_at) throw new PlatformError(403, 'email_unverified', 'Verify your email before accepting an invitation.');
      const candidate = await client.query(
        `SELECT journey_id FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2`,
        [sha256(rawToken), this.now()],
      );
      if (!candidate.rowCount) throw new PlatformError(400, 'invalid_invitation', 'This invitation is invalid, expired, or belongs to another email address.');
      await this.lockJourney(client, candidate.rows[0].journey_id);
      const invitation = await client.query(
        `SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>$2 FOR UPDATE`,
        [sha256(rawToken), this.now()],
      );
      if (!invitation.rowCount || invitation.rows[0].email_normalized !== user.rows[0].email_normalized) throw new PlatformError(400, 'invalid_invitation', 'This invitation is invalid, expired, or belongs to another email address.');
      const members = await client.query('SELECT count(*)::int AS count FROM journey_members WHERE journey_id=$1', [invitation.rows[0].journey_id]);
      if (Number(members.rows[0].count) >= 2) throw new PlatformError(409, 'journey_full', 'This journey already has two members.');
      await client.query(`INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [invitation.rows[0].journey_id, userId]);
      await client.query('UPDATE invitations SET accepted_at=$1 WHERE id=$2', [this.now(), invitation.rows[0].id]);
      await this.appendEvent(client, { journeyId: invitation.rows[0].journey_id, actorUserId: userId, action: 'member_joined', entityType: 'membership', entityId: userId, summary: 'Accepted journey invitation', after: { userId } });
      return invitation.rows[0].journey_id;
    });
  }

  async removeMember(userId, journeyId, memberUserId) {
    if (userId === memberUserId) throw new PlatformError(400, 'invalid_member', 'The journey owner cannot remove themselves.');
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId, { owner: true });
      await this.lockJourney(client, journeyId);
      const member = await client.query(`SELECT jm.*,u.display_name FROM journey_members jm JOIN users u ON u.id=jm.user_id WHERE jm.journey_id=$1 AND jm.user_id=$2 FOR UPDATE`, [journeyId, memberUserId]);
      if (!member.rowCount) throw notFound();
      if (member.rows[0].role === 'owner') throw new PlatformError(400, 'invalid_member', 'The journey owner cannot be removed.');
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'member_removed', entityType: 'membership', entityId: memberUserId, summary: `Removed journey member: ${member.rows[0].display_name}`, before: { userId: memberUserId, role: member.rows[0].role }, after: null });
      await client.query('DELETE FROM journey_members WHERE journey_id=$1 AND user_id=$2', [journeyId, memberUserId]);
    });
  }

  async createExpense(userId, journeyId, input) {
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const id = randomUUID();
      const merchant = cleanText(input.merchant, 'Expense name', 80);
      const amountCents = Number(input.amountCents);
      if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) throw new PlatformError(400, 'invalid_input', 'Enter a valid amount.');
      if (!CATEGORIES.has(input.category)) throw new PlatformError(400, 'invalid_input', 'Choose a valid category.');
      if (!DATE_PATTERN.test(input.occurredOn || '')) throw new PlatformError(400, 'invalid_input', 'Choose a valid expense date.');
      const created = await client.query(
        `INSERT INTO expenses (id,journey_id,merchant,category,amount_cents,occurred_on,paid_by_user_id,payer_label,account,status,reference,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id, journeyId, merchant, input.category, amountCents, input.occurredOn, input.paidByUserId || null, cleanText(input.payerLabel, 'Payer', 80), String(input.account || '').slice(0, 50), input.status === 'due' ? 'due' : 'paid', String(input.reference || '').slice(0, 60), String(input.notes || '').slice(0, 300)],
      );
      const expense = publicExpense(created.rows[0]);
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'expense_added', entityType: 'expense', entityId: id, summary: `Added expense: ${merchant}`, after: auditExpense(expense) });
      return expense;
    });
  }

  async mutateExpense(userId, journeyId, expenseId, input, { remove = false } = {}) {
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const found = await client.query('SELECT * FROM expenses WHERE id=$1 AND journey_id=$2 FOR UPDATE', [expenseId, journeyId]);
      if (!found.rowCount) throw notFound();
      const before = publicExpense(found.rows[0]);
      if (Number(input.version) !== before.version) throw new PlatformError(409, 'conflict', 'This expense changed on another device.');
      if (remove) {
        await client.query('DELETE FROM expenses WHERE id=$1', [expenseId]);
        await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'expense_deleted', entityType: 'expense', entityId: expenseId, summary: `Deleted expense: ${before.merchant}`, before: auditExpense(before), after: null });
        return null;
      }
      const nextAmount = Number(input.amountCents ?? before.amountCents);
      const nextCategory = input.category ?? before.category;
      const nextDate = input.occurredOn ?? before.occurredOn;
      const nextStatus = input.status ?? before.status;
      if (!Number.isSafeInteger(nextAmount) || nextAmount < 1 || nextAmount > 100000000 || !CATEGORIES.has(nextCategory) || !DATE_PATTERN.test(nextDate) || !STATUSES.has(nextStatus)) throw new PlatformError(400, 'invalid_input', 'Expense details are not valid.');
      const updated = await client.query(
        `UPDATE expenses SET merchant=$1,category=$2,amount_cents=$3,occurred_on=$4,paid_by_user_id=$5,payer_label=$6,account=$7,status=$8,reference=$9,notes=$10,version=version+1,updated_at=$11 WHERE id=$12 RETURNING *`,
        [cleanText(input.merchant ?? before.merchant, 'Expense name', 80), nextCategory, nextAmount, nextDate, input.paidByUserId ?? before.paidByUserId, cleanText(input.payerLabel ?? before.payerLabel, 'Payer', 80), String(input.account ?? before.account).slice(0, 50), nextStatus, String(input.reference ?? before.reference).slice(0, 60), String(input.notes ?? before.notes).slice(0, 300), this.now(), expenseId],
      );
      const after = publicExpense(updated.rows[0]);
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'expense_updated', entityType: 'expense', entityId: expenseId, summary: `Updated expense: ${after.merchant}`, before: auditExpense(before), after: auditExpense(after) });
      return after;
    });
  }

  async createMoment(userId, journeyId, input) {
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const id = randomUUID();
      const next = cleanMoment(input);
      const created = await client.query(
        `INSERT INTO journey_moments (id,journey_id,kind,kind_label,occurred_on,title,detail,money_cents,money_currency,created_by_user_id,updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, journeyId, next.kind, next.kindLabel, next.occurredOn, next.title, next.detail, next.moneyCents, next.moneyCurrency, userId, userId],
      );
      const moment = publicMoment(created.rows[0]);
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'moment_added', entityType: 'moment', entityId: id, summary: `Held ${moment.kindLabel || moment.kind}: ${moment.title}`, after: auditMoment(moment) });
      return moment;
    });
  }

  async mutateMoment(userId, journeyId, momentId, input, { remove = false } = {}) {
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const found = await client.query('SELECT * FROM journey_moments WHERE id=$1 AND journey_id=$2 FOR UPDATE', [momentId, journeyId]);
      if (!found.rowCount) throw notFound();
      const before = publicMoment(found.rows[0]);
      if (Number(input.version) !== before.version) throw new PlatformError(409, 'conflict', 'This moment changed on another device.');
      if (remove) {
        await client.query('DELETE FROM journey_moments WHERE id=$1', [momentId]);
        await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'moment_deleted', entityType: 'moment', entityId: momentId, summary: `Deleted moment: ${before.title}`, before: auditMoment(before), after: null });
        return null;
      }
      const next = cleanMoment(input, before);
      const updated = await client.query(
        `UPDATE journey_moments SET kind=$1,kind_label=$2,occurred_on=$3,title=$4,detail=$5,money_cents=$6,money_currency=$7,updated_by_user_id=$8,version=version+1,updated_at=$9 WHERE id=$10 RETURNING *`,
        [next.kind, next.kindLabel, next.occurredOn, next.title, next.detail, next.moneyCents, next.moneyCurrency, userId, this.now(), momentId],
      );
      const after = publicMoment(updated.rows[0]);
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'moment_updated', entityType: 'moment', entityId: momentId, summary: `Updated moment: ${after.title}`, before: auditMoment(before), after: auditMoment(after) });
      return after;
    });
  }

  async createConcern(userId, journeyId, input) {
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const id = randomUUID();
      const created = await client.query(
        `INSERT INTO concerns (id,journey_id,title,detail,status) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, journeyId, cleanText(input.title, 'Concern', 100), String(input.detail || '').slice(0, 500), input.status === 'resolved' ? 'resolved' : 'open'],
      );
      const concern = publicConcern(created.rows[0]);
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'concern_added', entityType: 'concern', entityId: id, summary: `Logged concern: ${concern.title}`, after: { ...concern, detail: concern.detail ? '[recorded]' : '' } });
      return concern;
    });
  }

  async mutateConcern(userId, journeyId, concernId, input, { remove = false } = {}) {
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const found = await client.query('SELECT * FROM concerns WHERE id=$1 AND journey_id=$2 FOR UPDATE', [concernId, journeyId]);
      if (!found.rowCount) throw notFound();
      const before = publicConcern(found.rows[0]);
      if (Number(input.version) !== before.version) throw new PlatformError(409, 'conflict', 'This concern changed on another device.');
      const auditBefore = { ...before, detail: before.detail ? '[recorded]' : '' };
      if (remove) {
        await client.query('DELETE FROM concerns WHERE id=$1', [concernId]);
        await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'concern_deleted', entityType: 'concern', entityId: concernId, summary: `Deleted concern: ${before.title}`, before: auditBefore, after: null });
        return null;
      }
      const nextStatus = input.status ?? before.status;
      if (!CONCERN_STATUSES.has(nextStatus)) throw new PlatformError(400, 'invalid_input', 'Choose a valid concern status.');
      const updated = await client.query(
        `UPDATE concerns SET title=$1,detail=$2,status=$3,version=version+1,updated_at=$4 WHERE id=$5 RETURNING *`,
        [cleanText(input.title ?? before.title, 'Concern', 100), String(input.detail ?? before.detail).slice(0, 500), nextStatus, this.now(), concernId],
      );
      const after = publicConcern(updated.rows[0]);
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'concern_updated', entityType: 'concern', entityId: concernId, summary: `Updated concern: ${after.title}`, before: auditBefore, after: { ...after, detail: after.detail ? '[recorded]' : '' } });
      return after;
    });
  }

  async setMilestone(userId, journeyId, key, completed) {
    if (!['reviewedPicture', 'chosePrompt', 'agreedNextAction'].includes(key)) throw notFound();
    return withTransaction(this.pool, async (client) => {
      await this.requireMember(client, userId, journeyId);
      await this.lockJourney(client, journeyId);
      const existing = await client.query('SELECT * FROM journey_milestones WHERE journey_id=$1 AND key=$2', [journeyId, key]);
      const before = { key, completed: existing.rows[0]?.completed ?? false };
      await client.query(
        `INSERT INTO journey_milestones (journey_id,key,completed,updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (journey_id,key) DO UPDATE SET completed=EXCLUDED.completed,updated_at=EXCLUDED.updated_at`,
        [journeyId, key, Boolean(completed), this.now()],
      );
      const after = { key, completed: Boolean(completed) };
      await this.appendEvent(client, { journeyId, actorUserId: userId, action: 'milestone_updated', entityType: 'milestone', entityId: key, summary: `${after.completed ? 'Completed' : 'Reopened'} milestone: ${key}`, before, after });
      return after;
    });
  }

  async snapshot(userId, journeyId, afterSequence = 0) {
    const client = await this.pool.connect();
    try {
      if (this.config.NODE_ENV !== 'test') await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const journey = await this.requireMember(client, userId, journeyId);
      const [members, invitations, expenses, moments, concerns, milestones, events] = await Promise.all([
        client.query(`SELECT u.id,u.display_name,jm.role,jm.joined_at FROM journey_members jm JOIN users u ON u.id=jm.user_id WHERE jm.journey_id=$1 ORDER BY jm.joined_at,jm.user_id`, [journeyId]),
        client.query(`SELECT i.*,u.display_name AS invited_by_display_name FROM invitations i JOIN users u ON u.id=i.invited_by_user_id WHERE i.journey_id=$1 ORDER BY i.created_at,i.id`, [journeyId]),
        client.query('SELECT * FROM expenses WHERE journey_id=$1 ORDER BY occurred_on,id', [journeyId]),
        client.query(`SELECT m.*,creator.display_name AS created_by_name,editor.display_name AS updated_by_name
          FROM journey_moments m
          LEFT JOIN users creator ON creator.id=m.created_by_user_id
          LEFT JOIN users editor ON editor.id=m.updated_by_user_id
          WHERE m.journey_id=$1 ORDER BY m.occurred_on,m.created_at,m.id`, [journeyId]),
        client.query('SELECT * FROM concerns WHERE journey_id=$1 ORDER BY updated_at DESC', [journeyId]),
        client.query('SELECT key,completed,updated_at FROM journey_milestones WHERE journey_id=$1', [journeyId]),
        client.query('SELECT * FROM journey_events WHERE journey_id=$1 AND sequence>$2 ORDER BY sequence', [journeyId, Number(afterSequence) || 0]),
      ]);
      const publicEvents = events.rows.map(publicEvent);
      let previousHash = '0'.repeat(64);
      const eventChainValid = publicEvents.every((event) => {
        const signed = { journeyId, sequence: event.sequence, actorUserId: event.actorUserId, action: event.action, entityType: event.entityType, entityId: event.entityId, summary: event.summary, before: event.before, after: event.after, previousHash: event.previousHash, createdAt: event.createdAt };
        const valid = event.previousHash === previousHash && event.eventHash === eventHmac(this.config.AUDIT_HMAC_KEY, signed);
        previousHash = event.eventHash;
        return valid;
      });
      const snapshot = {
        journey: publicJourney(journey),
        members: members.rows.map((row) => ({ id: row.id, displayName: row.display_name, role: row.role, joinedAt: dateTime(row.joined_at) })),
        invitations: invitations.rows.map((row) => publicInvitation(row, this.now())),
        expenses: expenses.rows.map(publicExpense),
        moments: moments.rows.map(publicMoment),
        concerns: concerns.rows.map(publicConcern),
        milestones: milestones.rows.map((row) => ({ key: row.key, completed: row.completed, updatedAt: row.updated_at })),
        events: publicEvents,
        eventChainValid: Number(afterSequence) > 0 ? null : eventChainValid,
      };
      if (this.config.NODE_ENV !== 'test') await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      if (this.config.NODE_ENV !== 'test') await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteAccount(userId, password) {
    const user = await this.pool.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [userId]);
    if (!user.rowCount || !await verifyPassword(user.rows[0].password_hash, password)) throw new PlatformError(401, 'invalid_credentials', 'Password confirmation failed.');
    await withTransaction(this.pool, async (client) => {
      const memberships = await client.query('SELECT jm.*,j.owner_user_id FROM journey_members jm JOIN journeys j ON j.id=jm.journey_id WHERE jm.user_id=$1', [userId]);
      for (const membership of memberships.rows) {
        await this.lockJourney(client, membership.journey_id);
        const others = await client.query('SELECT * FROM journey_members WHERE journey_id=$1 AND user_id<>$2 ORDER BY joined_at LIMIT 1', [membership.journey_id, userId]);
        if (!others.rowCount) {
          if (this.config.NODE_ENV !== 'test') await client.query(`SET LOCAL together.allow_event_purge='on'`);
          await client.query('DELETE FROM journeys WHERE id=$1', [membership.journey_id]);
        } else {
          const successor = others.rows[0].user_id;
          const attributedExpenses = await client.query('SELECT * FROM expenses WHERE journey_id=$1 AND paid_by_user_id=$2 FOR UPDATE', [membership.journey_id, userId]);
          for (const row of attributedExpenses.rows) {
            const before = publicExpense(row);
            const updated = await client.query(
              `UPDATE expenses SET paid_by_user_id=NULL,payer_label='Deleted account',version=version+1,updated_at=$1 WHERE id=$2 RETURNING *`,
              [this.now(), row.id],
            );
            await this.appendEvent(client, { journeyId: membership.journey_id, actorUserId: userId, action: 'expense_payer_pseudonymized', entityType: 'expense', entityId: row.id, summary: 'Removed deleted account from expense payer attribution', before: auditExpense(before), after: auditExpense(publicExpense(updated.rows[0])) });
          }
          if (membership.owner_user_id === userId) {
            await client.query(`UPDATE journey_members SET role='owner' WHERE journey_id=$1 AND user_id=$2`, [membership.journey_id, successor]);
            await client.query('UPDATE journeys SET owner_user_id=$1,version=version+1,updated_at=$2 WHERE id=$3', [successor, this.now(), membership.journey_id]);
            await this.appendEvent(client, { journeyId: membership.journey_id, actorUserId: userId, action: 'ownership_transferred', entityType: 'journey', entityId: membership.journey_id, summary: 'Transferred journey ownership during account deletion', before: { ownerUserId: userId }, after: { ownerUserId: successor } });
          }
          await this.appendEvent(client, { journeyId: membership.journey_id, actorUserId: userId, action: 'member_deleted_account', entityType: 'membership', entityId: userId, summary: 'A journey member deleted their account', before: { userId }, after: null });
          await client.query('DELETE FROM journey_members WHERE journey_id=$1 AND user_id=$2', [membership.journey_id, userId]);
        }
      }
      await client.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM account_tokens WHERE user_id=$1', [userId]);
      await client.query('DELETE FROM invitations WHERE invited_by_user_id=$1', [userId]);
      await client.query('UPDATE invitations SET revoked_at=$1 WHERE email_normalized=$2 AND accepted_at IS NULL AND revoked_at IS NULL', [this.now(), user.rows[0].email_normalized]);
      await client.query(
        'UPDATE users SET email_normalized=$1,username=$2,display_name=$3,password_hash=$4,deleted_at=$5 WHERE id=$6',
        [`deleted-${userId}@invalid.local`, `deleted-${userId.slice(0, 8)}`, 'Deleted account', 'deleted', this.now(), userId],
      );
    });
  }
}
