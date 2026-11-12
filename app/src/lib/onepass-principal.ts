import { APP_ROLES, type AppRole, type Principal } from './auth';
import type { OnePassIdentity } from './onepass';

export async function expensePrincipalFromOnePass(db: D1Database, identity: OnePassIdentity): Promise<Principal | null> {
  const membership = identity.membership;
  const mapped = await db.prepare(
    `SELECT u.id AS user_id, u.email, COALESCE((
       SELECT group_concat(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id
     ), '') AS role_codes
     FROM onepass_local_accounts a JOIN users u ON u.id = a.user_id
     WHERE a.org_id = ? AND a.membership_id = ? AND a.enabled = 1 AND u.employment_status = 'active'`,
  ).bind(membership.org_id, membership.id).first<{ user_id: string; email: string | null; role_codes: string }>();
  if (!mapped) return null;
  const roles = membership.application_roles ?? mapped.role_codes.split(',')
    .filter((role): role is AppRole => APP_ROLES.includes(role as AppRole));
  return {
    issuer: 'onepass',
    subject: membership.id,
    userId: mapped.user_id,
    ...(mapped.email ? { email: mapped.email } : {}),
    roles: [...roles].sort(),
  };
}
