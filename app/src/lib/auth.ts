import type { Env } from './types';
import { normalizeVerifiedEmail, type AccessEntry } from './access-entry';

export const APP_ROLES = [
  'system_admin',
  'asset_admin',
  'finance_reviewer',
  'payer',
  'employee',
  'auditor',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export interface AccessClaims {
  sub?: unknown;
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  email?: unknown;
}

export interface AuthenticatedIdentity {
  issuer: string;
  subject: string;
  email?: string;
}

export interface Principal extends AuthenticatedIdentity {
  userId: string;
  roles: AppRole[];
}

/**
 * Validates claims only after the JWT signature has been checked. This keeps
 * the security boundary explicit: headers and an unverified payload are never
 * treated as an authenticated identity.
 */
export function validateAccessClaims(
  claims: AccessClaims,
  options: { audience: string; issuer: string; nowEpochSeconds?: number },
): AuthenticatedIdentity {
  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud)
    ? claims.aud
    : typeof claims.aud === 'string'
      ? [claims.aud]
      : [];
  if (!audiences.includes(options.audience)) {
    throw new Error('Access JWT audience is invalid');
  }
  if (typeof claims.iss !== 'string' || claims.iss !== options.issuer) {
    throw new Error('Access JWT issuer is invalid');
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) {
    throw new Error('Access JWT is expired');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('Access JWT subject is missing');
  }
  return {
    issuer: claims.iss,
    subject: claims.sub,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
  };
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
  } catch {
    throw new Error('Access JWT payload is invalid');
  }
}

/**
 * Verifies a Cloudflare Access JWT through its published JWKs. Production
 * callers must use this function before looking up business roles in D1.
 */
export async function verifyCloudflareAccessJwt(
  token: string,
  options: {
    audience: string;
    issuer: string;
    jwksUrl: string;
    fetcher?: typeof fetch;
  },
): Promise<AuthenticatedIdentity> {
  const [encodedHeader, encodedPayload, encodedSignature, ...extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length > 0) {
    throw new Error('Access JWT has an invalid format');
  }
  const header = decodeJson<{ alg?: unknown; kid?: unknown }>(encodedHeader);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('Access JWT signing algorithm is invalid');
  }
  const fetcher = options.fetcher ?? fetch;
  const jwksResponse = await fetcher(options.jwksUrl, { headers: { Accept: 'application/json' } });
  if (!jwksResponse.ok) throw new Error('unable to load Cloudflare Access keys');
  const jwks = (await jwksResponse.json()) as {
    keys?: Array<JsonWebKey & { kid?: string }>;
  };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new Error('Access JWT key id is unknown');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const isValid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    base64UrlToBytes(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!isValid) throw new Error('Access JWT signature is invalid');
  return validateAccessClaims(decodeJson<AccessClaims>(encodedPayload), options);
}

/**
 * Resolves a principal. Development mode intentionally requires a configured
 * DEV_AUTH flag; production accepts only a verified Cloudflare Access JWT.
 */
export async function resolveAuthenticatedIdentity(
  request: Request,
  env: Env,
  entry: AccessEntry,
): Promise<AuthenticatedIdentity | null> {
  if (env.ENVIRONMENT !== 'production' && env.DEV_AUTH === '1') {
    const subject = request.headers.get('x-dev-subject');
    if (!subject) return null;
    const email = request.headers.get('x-dev-email');
    return { issuer: 'dev://local', subject, ...(email ? { email } : {}) };
  }
  if (!entry || !env.ACCESS_ISSUER || !env.ACCESS_JWKS_URL) return null;
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) return null;
  const identity = await verifyCloudflareAccessJwt(assertion, {
    audience: entry.audience,
    issuer: env.ACCESS_ISSUER,
    jwksUrl: env.ACCESS_JWKS_URL,
  });
  return validateIdentityForEntry(identity, entry);
}

/**
 * Applies entry-specific requirements only to an identity that has already
 * passed Access signature, issuer, audience, and expiry validation.
 * 企业入口要求已验证邮箱（不限域名）；谁能自动开户由 D1 登录白名单决定。
 */
export function validateIdentityForEntry(
  identity: AuthenticatedIdentity,
  entry: AccessEntry,
): AuthenticatedIdentity {
  if ((entry.kind === 'corporate' || entry.kind === 'legacy') && !normalizeVerifiedEmail(identity.email)) {
    throw new Error('corporate Access identity requires a verified email');
  }
  return identity;
}

export function requireAnyRole(principal: Principal | null, allowed: AppRole[]): Principal {
  if (!principal) throw new Error('authentication required');
  if (!principal.roles.some((role) => allowed.includes(role))) {
    throw new Error('insufficient role');
  }
  return principal;
}
