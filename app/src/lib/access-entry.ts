import type { Env } from './types';

export type AccessEntryKind = 'corporate' | 'legacy';

export interface AccessEntry {
  kind: AccessEntryKind;
  hostname: string;
  audience: string;
  origin: string;
}

const CORPORATE_HOSTNAME = 'ie-oa.lancloudtech.com';
const LEGACY_HOSTNAME = 'ie_oa.lancloudtech.com';

function hostnameWithoutPort(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '');
}

export function accessEntryForRequest(host: string, env: Env): AccessEntry | null {
  const hostname = hostnameWithoutPort(host);
  if (hostname === CORPORATE_HOSTNAME && env.ACCESS_AUD_CORPORATE) {
    return {
      kind: 'corporate',
      hostname: CORPORATE_HOSTNAME,
      audience: env.ACCESS_AUD_CORPORATE,
      origin: `https://${CORPORATE_HOSTNAME}`,
    };
  }
  if (hostname === LEGACY_HOSTNAME && env.ACCESS_AUD_CORPORATE) {
    return {
      kind: 'legacy',
      hostname: LEGACY_HOSTNAME,
      audience: env.ACCESS_AUD_CORPORATE,
      origin: '',
    };
  }
  return null;
}

export function isCorporateEmail(email: string | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const [localPart, domain, ...extra] = normalized.split('@');
  return localPart && domain === 'lancloudtech.com' && extra.length === 0 ? normalized : null;
}

/** 规范化任何域的已验证邮箱；不合法（缺段、多 @）返回 null。 */
export function normalizeVerifiedEmail(email: string | undefined): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  const [localPart, domain, ...extra] = normalized.split('@');
  return localPart && domain && domain.includes('.') && extra.length === 0 ? normalized : null;
}

export function isAllowedEntryOrigin(origin: string | undefined, entry: AccessEntry): boolean {
  return Boolean(origin && entry.origin && origin === entry.origin);
}
