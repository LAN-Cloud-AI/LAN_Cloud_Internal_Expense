import { isCorporateEmail, normalizeVerifiedEmail, type AccessEntryKind } from './access-entry';
import type { AppRole, AuthenticatedIdentity } from './auth';
import { APP_ROLES } from './auth';
import { canUseIdentityAtEntry, type IdentityKind } from './identity-policy';

export type IdentityProblemCode =
  | 'corporate_email_required'
  | 'email_not_whitelisted'
  | 'corporate_identity_required'
  | 'identity_kind_conflict'
  | 'identity_already_bound'
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

interface MutationMarker {
  id: string;
}

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
    const corporateEmail = normalizeVerifiedEmail(identity.email);
    if (!corporateEmail) throw new IdentityProblem('corporate_email_required');
    // 谁能自动开户由登录白名单决定（Access 边缘 policy 是第一道门）。
    if (!(await this.isLoginWhitelisted(corporateEmail))) throw new IdentityProblem('email_not_whitelisted');

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
          // 管理员预置的用户行（email 匹配且从未登录过）：首次 OTP 登录时收养，
          // 把登录身份挂到该行而不是另建新账号；身份键仍是已验签的 (issuer, subject)。
          const provisioned = await this.db.prepare(
            `SELECT user.id FROM users AS user
             WHERE user.email = ? AND user.employment_status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM user_access_identities AS identity WHERE identity.user_id = user.id
               )
             LIMIT 1`,
          ).bind(corporateEmail).first<{ id: string }>();
          if (provisioned) {
            const identityId = newId();
            await this.db.batch([
              this.db.prepare(
                `INSERT INTO user_access_identities
                  (id, user_id, issuer, subject, verified_email, identity_kind, provider_hint, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, 'corporate_primary', 'cloudflare', ?)`,
              ).bind(identityId, provisioned.id, identity.issuer, identity.subject, corporateEmail, asIso(new Date())),
              this.employeeRoleStatement(provisioned.id),
              this.auditStatement(
                'adopt_provisioned_user',
                provisioned.id,
                'identity',
                identityId,
                { identityId },
              ),
            ]);
            principal = await this.requirePrincipalById(identityId);
          } else {
            const userId = newId();
            const identityId = newId();
            // 复制 OTP 已验证邮箱到用户主表（仅在该邮箱未被占用时），登录身份与用户行一致可查。
            const emailTaken = await this.db.prepare(
              `SELECT 1 AS hit FROM users WHERE email = ? LIMIT 1`,
            ).bind(corporateEmail).first<{ hit: number }>();
            await this.db.batch([
              this.db.prepare(
                `INSERT INTO users (id, email, display_name, employment_status) VALUES (?, ?, ?, 'active')`,
              ).bind(userId, emailTaken ? null : corporateEmail, displayNameFromEmail(corporateEmail)),
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

  /** 白名单命中：精确邮箱或邮箱域名任一规则匹配即视为可自动开户。 */
  private async isLoginWhitelisted(email: string): Promise<boolean> {
    const domain = email.slice(email.indexOf('@') + 1);
    const hit = await this.db.prepare(
      `SELECT 1 AS hit FROM login_whitelist
       WHERE (kind = 'email' AND value = ?) OR (kind = 'domain' AND value = ?) LIMIT 1`,
    ).bind(email, domain).first<{ hit: number }>();
    return Boolean(hit);
  }

  private rethrowProblem(error: unknown): never {
    if (error instanceof IdentityProblem) throw error;
    throw new IdentityProblem('identity_store_unavailable');
  }
}
