import { isCorporateEmail, type AccessEntryKind } from './access-entry';
import type { AppRole, AuthenticatedIdentity } from './auth';
import { APP_ROLES } from './auth';
import {
  canUseIdentityAtEntry,
  createBindingSecret,
  hashBindingSecret,
  maskIdentityEmail,
  type IdentityKind,
} from './identity-policy';

type ProviderHint = 'cloudflare' | 'github' | null;

export type IdentityProblemCode =
  | 'corporate_email_required'
  | 'corporate_identity_required'
  | 'identity_kind_conflict'
  | 'identity_already_bound'
  | 'link_not_found'
  | 'link_secret_consumed'
  | 'link_expired'
  | 'link_candidate_missing'
  | 'link_owner_mismatch'
  | 'linked_identity_not_found'
  | 'identity_store_unavailable';

/** A route-safe error: callers may expose `code`, but never D1 error details. */
export class IdentityProblem extends Error {
  constructor(public readonly code: IdentityProblemCode) {
    super(code);
    this.name = 'IdentityProblem';
  }
}

export interface ResolvedIdentityPrincipal {
  userId: string;
  identityId: string;
  identityKind: IdentityKind;
  issuer: string;
  subject: string;
  email?: string;
  roles: AppRole[];
}

export interface MaskedIdentitySummary {
  id: string;
  identity_kind: IdentityKind;
  provider_hint: ProviderHint;
  email_masked: string | null;
  status: 'active' | 'revoked';
}

/**
 * A caller-safe recovery record for an unfinished external identity link.
 * Binding secrets and raw external identity claims intentionally never leave
 * the transaction table through this type.
 */
export interface ResumableLinkTransactionSummary {
  id: string;
  status: 'pending' | 'candidate_presented';
  expires_at: string;
  provider_hint: ProviderHint;
  email_masked: string | null;
}

interface IdentityRow {
  identity_id: string;
  user_id: string;
  identity_kind: IdentityKind;
  issuer: string;
  subject: string;
  verified_email: string | null;
  revoked_at: string | null;
  role_codes: string;
}

interface StoredIdentityPrincipal extends ResolvedIdentityPrincipal {
  revokedAt: string | null;
}

interface LinkTransactionRow {
  id: string;
  user_id: string;
  status: string;
  expires_at: string;
  consumed_at: string | null;
  candidate_issuer: string | null;
  candidate_subject: string | null;
  candidate_verified_email: string | null;
  candidate_provider_hint: ProviderHint;
}

interface MutationMarker {
  id: string;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

function asIso(date: Date): string {
  return date.toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function displayNameFromEmail(email: string): string {
  return email.slice(0, email.indexOf('@')) || '员工';
}

/**
 * D1 metadata is operational telemetry, not an authorization fact. Mutations
 * therefore return the caller's generated id through SQLite `RETURNING` and
 * are accepted only when that exact row is present in the D1 result set.
 */
function returnedMarker(result: D1Result<MutationMarker> | undefined, id: string): boolean {
  return result?.results.some((row) => row.id === id) ?? false;
}

export class IdentityStore {
  constructor(private readonly db: D1Database) {}

  async resolve(
    identity: AuthenticatedIdentity,
    entry: AccessEntryKind,
  ): Promise<ResolvedIdentityPrincipal | null> {
    try {
      const principal = await this.findPrincipal(identity.issuer, identity.subject);
      return principal && canUseIdentityAtEntry(entry, principal.identityKind) ? principal : null;
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  async ensureCorporatePrincipal(
    identity: AuthenticatedIdentity,
    options: { migrationAdminEmail?: string },
  ): Promise<ResolvedIdentityPrincipal> {
    const corporateEmail = isCorporateEmail(identity.email);
    if (!corporateEmail) throw new IdentityProblem('corporate_email_required');

    try {
      const existing = await this.findIdentity(identity.issuer, identity.subject, false);
      let principal: ResolvedIdentityPrincipal;
      if (existing) {
        if (existing.identityKind !== 'corporate_primary') {
          throw new IdentityProblem('identity_kind_conflict');
        }
        await this.db.batch([
          this.db.prepare(
            'UPDATE user_access_identities SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL',
          ).bind(asIso(new Date()), existing.identityId),
          this.employeeRoleStatement(existing.userId),
        ]);
        principal = existing;
      } else {
        const legacy = await this.findLegacyBySubject(identity.subject);
        if (legacy) {
          const auditId = newId();
          const upgradeResults = await this.db.batch<MutationMarker>([
            this.db.prepare(
              `UPDATE user_access_identities
               SET issuer = ?, subject = ?, verified_email = ?, identity_kind = 'corporate_primary',
                   last_seen_at = ?, revoked_at = NULL
               WHERE id = ? AND identity_kind = 'legacy_primary' AND revoked_at IS NULL
               RETURNING id`,
            ).bind(identity.issuer, identity.subject, corporateEmail, asIso(new Date()), legacy.identityId),
            this.db.prepare(
              `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
               SELECT ?, ?, 'upgrade_legacy_corporate_identity', 'identity', ?, ?
               WHERE changes() = 1
               RETURNING id`,
            ).bind(
              auditId,
              legacy.userId,
              legacy.identityId,
              JSON.stringify({ identityId: legacy.identityId }),
            ),
            this.db.prepare(
              `INSERT OR IGNORE INTO user_roles (user_id, role_id)
               SELECT ?, 'role-employee'
               WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
            ).bind(legacy.userId, auditId),
          ]);
          if (
            !returnedMarker(upgradeResults[0], legacy.identityId)
            || !returnedMarker(upgradeResults[1], auditId)
          ) {
            const winner = await this.findIdentity(identity.issuer, identity.subject, false);
            if (!winner || winner.identityId !== legacy.identityId) {
              throw new IdentityProblem('identity_kind_conflict');
            }
            principal = winner;
          } else {
            principal = await this.requirePrincipalById(legacy.identityId);
          }
        } else {
          const userId = newId();
          const identityId = newId();
          await this.db.batch([
            // Do not copy verified_email into users.email: that legacy field is unique and is never a merge key.
            this.db.prepare(
              `INSERT INTO users (id, display_name, employment_status) VALUES (?, ?, 'active')`,
            ).bind(userId, displayNameFromEmail(corporateEmail)),
            this.db.prepare(
              `INSERT INTO user_access_identities
                (id, user_id, issuer, subject, verified_email, identity_kind, provider_hint, last_seen_at)
               VALUES (?, ?, ?, ?, ?, 'corporate_primary', 'cloudflare', ?)`,
            ).bind(identityId, userId, identity.issuer, identity.subject, corporateEmail, asIso(new Date())),
            this.employeeRoleStatement(userId),
            this.auditStatement(
              'auto_provision_corporate_user',
              userId,
              'identity',
              identityId,
              { identityId },
            ),
          ]);
          principal = await this.requirePrincipalById(identityId);
        }
      }

      const migrationEmail = isCorporateEmail(options.migrationAdminEmail);
      if (migrationEmail && migrationEmail === corporateEmail && await this.migrationAdminIsAvailable()) {
        const auditId = newId();
        await this.db.batch([
          this.db.prepare(
            `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
             SELECT ?, ?, 'migrate_system_administrator', 'user', ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM audit_events WHERE action = 'migrate_system_administrator'
             )`,
          ).bind(auditId, principal.userId, principal.userId, JSON.stringify({ userId: principal.userId })),
          this.db.prepare(
            `INSERT OR IGNORE INTO user_roles (user_id, role_id)
             SELECT ?, 'role-system-admin'
             WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
          ).bind(principal.userId, auditId),
        ]);
      }
      return this.requirePrincipalById(principal.identityId);
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  async beginLinkTransaction(
    principal: ResolvedIdentityPrincipal,
    now: Date,
  ): Promise<{ id: string; secret: string; expiresAt: string }> {
    if (principal.identityKind !== 'corporate_primary') {
      throw new IdentityProblem('corporate_identity_required');
    }
    const secret = createBindingSecret();
    const id = newId();
    const nowIso = asIso(now);
    const expiresAt = asIso(new Date(now.getTime() + TEN_MINUTES_MS));
    const rotationAuditId = newId();
    try {
      await this.db.batch([
        // A replacement code is a security rotation: no earlier pending or
        // externally-presented code for this corporate user can remain live.
        this.db.prepare(
          `UPDATE identity_link_transactions
           SET status = 'cancelled', consumed_at = ?
           WHERE user_id = ? AND consumed_at IS NULL
             AND status IN ('pending', 'candidate_presented')`,
        ).bind(nowIso, principal.userId),
        // `changes()` reads the preceding UPDATE inside this D1 batch. The
        // audit intentionally identifies only the replacement transaction,
        // never a code or external identity claim.
        this.db.prepare(
          `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
           SELECT ?, ?, 'cancel_prior_live_identity_link_transactions', 'identity_link_transaction', ?, ?
           WHERE changes() > 0`,
        ).bind(
          rotationAuditId,
          principal.userId,
          id,
          JSON.stringify({ replacementTransactionId: id }),
        ),
        this.db.prepare(
          `INSERT INTO identity_link_transactions
            (id, user_id, initiator_identity_id, secret_hash, status, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        ).bind(id, principal.userId, principal.identityId, await hashBindingSecret(secret), expiresAt),
        this.auditStatement(
          'begin_linked_external_identity',
          principal.userId,
          'identity_link_transaction',
          id,
          { transactionId: id },
        ),
      ]);
      return { id, secret, expiresAt };
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  /** Returns only the corporate caller's own identities, without an issuer, subject, or full email. */
  async listMaskedIdentities(
    principal: ResolvedIdentityPrincipal,
  ): Promise<MaskedIdentitySummary[]> {
    if (principal.identityKind !== 'corporate_primary') {
      throw new IdentityProblem('corporate_identity_required');
    }
    try {
      const rows = await this.db.prepare(
        `SELECT id, identity_kind, provider_hint, verified_email, revoked_at
         FROM user_access_identities
         WHERE user_id = ?
         ORDER BY CASE identity_kind
           WHEN 'corporate_primary' THEN 0
           WHEN 'linked_external' THEN 1
           ELSE 2
         END, created_at, id`,
      ).bind(principal.userId).all<{
        id: string;
        identity_kind: IdentityKind;
        provider_hint: ProviderHint;
        verified_email: string | null;
        revoked_at: string | null;
      }>();
      return rows.results.map((identity) => ({
        id: identity.id,
        identity_kind: identity.identity_kind,
        provider_hint: identity.provider_hint,
        email_masked: maskIdentityEmail(identity.verified_email),
        status: identity.revoked_at ? 'revoked' : 'active',
      }));
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  /**
   * Returns only the corporate caller's live, unfinished link state. This is
   * deliberately a recovery view rather than a transaction export: it never
   * selects a binding secret, issuer, subject, or full external email.
   */
  async listResumableLinkTransactions(
    principal: ResolvedIdentityPrincipal,
    now: Date,
  ): Promise<ResumableLinkTransactionSummary[]> {
    if (principal.identityKind !== 'corporate_primary') {
      throw new IdentityProblem('corporate_identity_required');
    }
    try {
      const rows = await this.db.prepare(
        `SELECT id, status, expires_at, candidate_provider_hint, candidate_verified_email
         FROM identity_link_transactions
         WHERE user_id = ?
           AND consumed_at IS NULL
           AND expires_at > ?
           AND status IN ('pending', 'candidate_presented')
         ORDER BY expires_at, created_at, id`,
      ).bind(principal.userId, asIso(now)).all<{
        id: string;
        status: 'pending' | 'candidate_presented';
        expires_at: string;
        candidate_provider_hint: ProviderHint;
        candidate_verified_email: string | null;
      }>();
      return rows.results.map((transaction) => ({
        id: transaction.id,
        status: transaction.status,
        expires_at: transaction.expires_at,
        provider_hint: transaction.candidate_provider_hint,
        email_masked: maskIdentityEmail(transaction.candidate_verified_email),
      }));
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  async presentExternalIdentity(
    identity: AuthenticatedIdentity,
    secret: string,
    providerHint: ProviderHint,
    now: Date,
  ): Promise<{ transactionId: string; expiresAt: string }> {
    try {
      const transaction = await this.findLinkBySecret(await hashBindingSecret(secret));
      if (!transaction) throw new IdentityProblem('link_not_found');
      this.assertPresentable(transaction, now);

      const bound = await this.findIdentity(identity.issuer, identity.subject, true);
      if (
        bound
        && (
          bound.revokedAt === null
          || bound.userId !== transaction.user_id
          || bound.identityKind !== 'linked_external'
        )
      ) {
        throw new IdentityProblem('identity_already_bound');
      }

      const auditId = newId();
      const presentationResults = await this.db.batch<MutationMarker>([
        this.db.prepare(
          `UPDATE identity_link_transactions
           SET candidate_issuer = ?, candidate_subject = ?, candidate_verified_email = ?,
               candidate_provider_hint = ?, status = 'candidate_presented'
           WHERE id = ? AND status = 'pending' AND consumed_at IS NULL AND expires_at > ?
           RETURNING id`,
        ).bind(
          identity.issuer,
          identity.subject,
          identity.email?.trim().toLowerCase() ?? null,
          providerHint,
          transaction.id,
          asIso(now),
        ),
        this.db.prepare(
          `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
           SELECT ?, ?, 'present_linked_external_identity_candidate', 'identity_link_transaction', ?, ?
           WHERE changes() = 1
             AND EXISTS (
               SELECT 1 FROM identity_link_transactions
               WHERE id = ? AND user_id = ? AND status = 'candidate_presented'
                 AND consumed_at IS NULL AND candidate_issuer = ? AND candidate_subject = ?
             )
           RETURNING id`,
        ).bind(
          auditId,
          transaction.user_id,
          transaction.id,
          JSON.stringify({ transactionId: transaction.id, providerHint }),
          transaction.id,
          transaction.user_id,
          identity.issuer,
          identity.subject,
        ),
      ]);
      if (
        !returnedMarker(presentationResults[0], transaction.id)
        || !returnedMarker(presentationResults[1], auditId)
      ) {
        throw new IdentityProblem('link_secret_consumed');
      }
      return { transactionId: transaction.id, expiresAt: transaction.expires_at };
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  async confirmLinkTransaction(
    principal: ResolvedIdentityPrincipal,
    transactionId: string,
    now: Date,
  ): Promise<{ identityId: string; identityKind: 'linked_external' }> {
    if (principal.identityKind !== 'corporate_primary') {
      throw new IdentityProblem('corporate_identity_required');
    }
    try {
      const transaction = await this.findLinkById(transactionId);
      if (!transaction) throw new IdentityProblem('link_not_found');
      if (transaction.user_id !== principal.userId) throw new IdentityProblem('link_owner_mismatch');
      if (transaction.consumed_at || transaction.status === 'confirmed') {
        throw new IdentityProblem('link_secret_consumed');
      }
      if (transaction.expires_at <= asIso(now)) throw new IdentityProblem('link_expired');
      if (
        transaction.status !== 'candidate_presented'
        || !transaction.candidate_issuer
        || !transaction.candidate_subject
      ) {
        throw new IdentityProblem('link_candidate_missing');
      }

      const existing = await this.findIdentity(
        transaction.candidate_issuer,
        transaction.candidate_subject,
        true,
      );
      if (
        existing
        && (
          existing.revokedAt === null
          || existing.userId !== principal.userId
          || existing.identityKind !== 'linked_external'
        )
      ) {
        throw new IdentityProblem('identity_already_bound');
      }

      const identityId = existing?.identityId ?? newId();
      const confirmedAt = asIso(now);
      const identityMutation = existing
        ? this.db.prepare(
          `UPDATE user_access_identities
           SET verified_email = ?, provider_hint = ?, last_seen_at = ?, revoked_at = NULL
           WHERE id = ? AND user_id = ? AND identity_kind = 'linked_external' AND revoked_at IS NOT NULL
             AND issuer = ? AND subject = ?
             AND EXISTS (
               SELECT 1 FROM identity_link_transactions
               WHERE id = ? AND user_id = ? AND status = 'candidate_presented'
                 AND consumed_at IS NULL AND expires_at > ?
                 AND candidate_issuer = ? AND candidate_subject = ?
             )
           RETURNING id`,
        ).bind(
          transaction.candidate_verified_email,
          transaction.candidate_provider_hint,
          confirmedAt,
          identityId,
          principal.userId,
          transaction.candidate_issuer,
          transaction.candidate_subject,
          transaction.id,
          principal.userId,
          confirmedAt,
          transaction.candidate_issuer,
          transaction.candidate_subject,
        )
        : this.db.prepare(
          `INSERT INTO user_access_identities
            (id, user_id, issuer, subject, verified_email, identity_kind, provider_hint, last_seen_at)
           SELECT ?, ?, ?, ?, ?, 'linked_external', ?, ?
           FROM identity_link_transactions AS transaction_row
           WHERE transaction_row.id = ? AND transaction_row.user_id = ?
             AND transaction_row.status = 'candidate_presented'
             AND transaction_row.consumed_at IS NULL AND transaction_row.expires_at > ?
             AND transaction_row.candidate_issuer = ? AND transaction_row.candidate_subject = ?
             AND NOT EXISTS (
               SELECT 1 FROM user_access_identities
               WHERE issuer = ? AND subject = ?
             )
           RETURNING id`,
        ).bind(
          identityId,
          principal.userId,
          transaction.candidate_issuer,
          transaction.candidate_subject,
          transaction.candidate_verified_email,
          transaction.candidate_provider_hint,
          confirmedAt,
          transaction.id,
          principal.userId,
          confirmedAt,
          transaction.candidate_issuer,
          transaction.candidate_subject,
          transaction.candidate_issuer,
          transaction.candidate_subject,
        );
      const auditId = newId();
      const confirmationResults = await this.db.batch<MutationMarker>([
        identityMutation,
        this.db.prepare(
          `UPDATE identity_link_transactions
           SET status = 'confirmed', consumed_at = ?
           WHERE changes() = 1
             AND id = ? AND user_id = ? AND status = 'candidate_presented'
             AND consumed_at IS NULL AND expires_at > ?
             AND candidate_issuer = ? AND candidate_subject = ?
             AND EXISTS (
               SELECT 1 FROM user_access_identities
               WHERE id = ? AND user_id = ? AND identity_kind = 'linked_external'
                 AND issuer = ? AND subject = ? AND revoked_at IS NULL
             )
           RETURNING id`,
        ).bind(
          confirmedAt,
          transaction.id,
          principal.userId,
          confirmedAt,
          transaction.candidate_issuer,
          transaction.candidate_subject,
          identityId,
          principal.userId,
          transaction.candidate_issuer,
          transaction.candidate_subject,
        ),
        this.db.prepare(
          `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
           SELECT ?, ?, 'confirm_linked_external_identity', 'identity', ?, ?
           WHERE changes() = 1
             AND EXISTS (
               SELECT 1 FROM identity_link_transactions
               WHERE id = ? AND user_id = ? AND status = 'confirmed' AND consumed_at = ?
             )
           RETURNING id`,
        ).bind(
          auditId,
          principal.userId,
          identityId,
          JSON.stringify({ transactionId: transaction.id, providerHint: transaction.candidate_provider_hint }),
          transaction.id,
          principal.userId,
          confirmedAt,
        ),
      ]);
      if (
        !returnedMarker(confirmationResults[0], identityId)
        || !returnedMarker(confirmationResults[1], transaction.id)
        || !returnedMarker(confirmationResults[2], auditId)
      ) {
        const confirmed = await this.findLinkById(transaction.id);
        if (confirmed?.consumed_at || confirmed?.status === 'confirmed') {
          throw new IdentityProblem('link_secret_consumed');
        }
        const competing = await this.findIdentity(
          transaction.candidate_issuer,
          transaction.candidate_subject,
          true,
        );
        if (competing) throw new IdentityProblem('identity_already_bound');
        throw new IdentityProblem('identity_store_unavailable');
      }
      return { identityId, identityKind: 'linked_external' };
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  async revokeLinkedIdentity(
    principal: ResolvedIdentityPrincipal,
    identityId: string,
  ): Promise<void> {
    if (principal.identityKind !== 'corporate_primary') {
      throw new IdentityProblem('corporate_identity_required');
    }
    try {
      const revokedAt = asIso(new Date());
      const auditId = newId();
      const revocationResults = await this.db.batch<MutationMarker>([
        this.db.prepare(
          `UPDATE user_access_identities SET revoked_at = ?
           WHERE id = ? AND user_id = ? AND identity_kind = 'linked_external' AND revoked_at IS NULL
           RETURNING id`,
        ).bind(revokedAt, identityId, principal.userId),
        this.db.prepare(
          `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
           SELECT ?, ?, 'revoke_linked_external_identity', 'identity', ?, ?
           WHERE changes() = 1
             AND EXISTS (
               SELECT 1 FROM user_access_identities
               WHERE id = ? AND user_id = ? AND identity_kind = 'linked_external' AND revoked_at = ?
             )
           RETURNING id`,
        ).bind(
          auditId,
          principal.userId,
          identityId,
          JSON.stringify({ identityId }),
          identityId,
          principal.userId,
          revokedAt,
        ),
      ]);
      if (!returnedMarker(revocationResults[0], identityId)) {
        throw new IdentityProblem('linked_identity_not_found');
      }
      if (!returnedMarker(revocationResults[1], auditId)) {
        throw new IdentityProblem('identity_store_unavailable');
      }
    } catch (error) {
      this.rethrowProblem(error);
    }
  }

  private async findPrincipal(issuer: string, subject: string): Promise<ResolvedIdentityPrincipal | null> {
    const identity = await this.findIdentity(issuer, subject, false);
    return identity ? this.asResolvedPrincipal(identity) : null;
  }

  private async findIdentity(
    issuer: string,
    subject: string,
    includeRevoked: boolean,
  ): Promise<StoredIdentityPrincipal | null> {
    const row = await this.db.prepare(
      `SELECT identity.id AS identity_id, identity.user_id, identity.identity_kind,
              identity.issuer, identity.subject, identity.verified_email, identity.revoked_at,
              COALESCE((
                SELECT group_concat(role.code)
                FROM user_roles AS user_role
                JOIN roles AS role ON role.id = user_role.role_id
                WHERE user_role.user_id = identity.user_id
              ), '') AS role_codes
       FROM user_access_identities AS identity
       JOIN users AS user ON user.id = identity.user_id
       WHERE identity.issuer = ? AND identity.subject = ?
         AND user.employment_status = 'active'
         ${includeRevoked ? '' : 'AND identity.revoked_at IS NULL'}
       LIMIT 1`,
    ).bind(issuer, subject).first<IdentityRow>();
    return row ? this.toPrincipal(row) : null;
  }

  private async findLegacyBySubject(subject: string): Promise<ResolvedIdentityPrincipal | null> {
    const row = await this.db.prepare(
      `SELECT identity.id AS identity_id, identity.user_id, identity.identity_kind,
              identity.issuer, identity.subject, identity.verified_email, identity.revoked_at,
              COALESCE((
                SELECT group_concat(role.code)
                FROM user_roles AS user_role
                JOIN roles AS role ON role.id = user_role.role_id
                WHERE user_role.user_id = identity.user_id
              ), '') AS role_codes
       FROM user_access_identities AS identity
       JOIN users AS user ON user.id = identity.user_id
       WHERE identity.issuer = 'legacy://users.external_subject' AND identity.subject = ?
         AND identity.identity_kind = 'legacy_primary' AND identity.revoked_at IS NULL
         AND user.employment_status = 'active'
       LIMIT 1`,
    ).bind(subject).first<IdentityRow>();
    return row ? this.toPrincipal(row) : null;
  }

  private toPrincipal(row: IdentityRow): StoredIdentityPrincipal {
    const roles = row.role_codes
      .split(',')
      .filter((role): role is AppRole => APP_ROLES.includes(role as AppRole));
    roles.sort();
    return {
      userId: row.user_id,
      identityId: row.identity_id,
      identityKind: row.identity_kind,
      issuer: row.issuer,
      subject: row.subject,
      ...(row.verified_email ? { email: row.verified_email } : {}),
      roles,
      revokedAt: row.revoked_at,
    };
  }

  private asResolvedPrincipal(identity: StoredIdentityPrincipal): ResolvedIdentityPrincipal {
    const { revokedAt: _revokedAt, ...principal } = identity;
    return principal;
  }

  private async requirePrincipalById(identityId: string): Promise<ResolvedIdentityPrincipal> {
    const row = await this.db.prepare(
      `SELECT identity.id AS identity_id, identity.user_id, identity.identity_kind,
              identity.issuer, identity.subject, identity.verified_email, identity.revoked_at,
              COALESCE((
                SELECT group_concat(role.code)
                FROM user_roles AS user_role
                JOIN roles AS role ON role.id = user_role.role_id
                WHERE user_role.user_id = identity.user_id
              ), '') AS role_codes
       FROM user_access_identities AS identity
       JOIN users AS user ON user.id = identity.user_id
       WHERE identity.id = ? AND identity.revoked_at IS NULL AND user.employment_status = 'active'`,
    ).bind(identityId).first<IdentityRow>();
    if (!row) throw new IdentityProblem('identity_store_unavailable');
    return this.asResolvedPrincipal(this.toPrincipal(row));
  }

  private async findLinkBySecret(secretHash: string): Promise<LinkTransactionRow | null> {
    return this.db.prepare(
      `SELECT id, user_id, status, expires_at, consumed_at, candidate_issuer, candidate_subject,
              candidate_verified_email, candidate_provider_hint
       FROM identity_link_transactions WHERE secret_hash = ?`,
    ).bind(secretHash).first<LinkTransactionRow>();
  }

  private async findLinkById(id: string): Promise<LinkTransactionRow | null> {
    return this.db.prepare(
      `SELECT id, user_id, status, expires_at, consumed_at, candidate_issuer, candidate_subject,
              candidate_verified_email, candidate_provider_hint
       FROM identity_link_transactions WHERE id = ?`,
    ).bind(id).first<LinkTransactionRow>();
  }

  private assertPresentable(transaction: LinkTransactionRow, now: Date): void {
    if (transaction.consumed_at || transaction.status === 'confirmed') {
      throw new IdentityProblem('link_secret_consumed');
    }
    if (transaction.expires_at <= asIso(now)) throw new IdentityProblem('link_expired');
    if (transaction.status !== 'pending') throw new IdentityProblem('link_secret_consumed');
  }

  private employeeRoleStatement(userId: string): D1PreparedStatement {
    return this.db.prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, 'role-employee')",
    ).bind(userId);
  }

  private auditStatement(
    action: string,
    actorId: string,
    entityType: string,
    entityId: string,
    detail: Record<string, string | null>,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events (id, actor_id, action, entity_type, entity_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(newId(), actorId, action, entityType, entityId, JSON.stringify(detail));
  }

  private async migrationAdminIsAvailable(): Promise<boolean> {
    const prior = await this.db.prepare(
      "SELECT id FROM audit_events WHERE action = 'migrate_system_administrator' LIMIT 1",
    ).first<{ id: string }>();
    return !prior;
  }

  private rethrowProblem(error: unknown): never {
    if (error instanceof IdentityProblem) throw error;
    throw new IdentityProblem('identity_store_unavailable');
  }
}
