import { describe, expect, it } from 'vitest';
import {
  resolveAccessProviderHint,
  resolveAuthenticatedIdentity,
  validateAccessClaims,
  validateIdentityForEntry,
} from '../src/lib/auth';
import type { AccessEntry } from '../src/lib/access-entry';
import type { Env } from '../src/lib/types';

describe('validateAccessClaims', () => {
  const now = 1_800_000_000;

  it('接受签名已验证且 audience、issuer、有效期均正确的 Access claims', () => {
    expect(
      validateAccessClaims(
        {
          sub: 'access-subject-1',
          aud: ['aud-expected'],
          iss: 'https://team.cloudflareaccess.com',
          exp: now + 60,
          email: 'person@example.com',
        },
        {
          audience: 'aud-expected',
          issuer: 'https://team.cloudflareaccess.com',
          nowEpochSeconds: now,
        },
      ),
    ).toEqual({
      issuer: 'https://team.cloudflareaccess.com',
      subject: 'access-subject-1',
      email: 'person@example.com',
    });
  });

  it.each([
    [
      '过期 token',
      { sub: 's', aud: ['aud-expected'], iss: 'https://team.cloudflareaccess.com', exp: now - 1 },
    ],
    [
      '错误 audience',
      { sub: 's', aud: ['wrong'], iss: 'https://team.cloudflareaccess.com', exp: now + 60 },
    ],
    [
      '错误 issuer',
      { sub: 's', aud: ['aud-expected'], iss: 'https://other.cloudflareaccess.com', exp: now + 60 },
    ],
    ['缺少 issuer', { sub: 's', aud: ['aud-expected'], exp: now + 60 }],
    [
      '缺少 subject',
      { aud: ['aud-expected'], iss: 'https://team.cloudflareaccess.com', exp: now + 60 },
    ],
  ])('拒绝%s', (_name, claims) => {
    expect(() =>
      validateAccessClaims(claims, {
        audience: 'aud-expected',
        issuer: 'https://team.cloudflareaccess.com',
        nowEpochSeconds: now,
      }),
    ).toThrow();
  });
});

describe('resolveAccessProviderHint', () => {
  it('uses same-host Access identity metadata only as an advisory provider hint', async () => {
    const request = new Request('https://external-ie-oa.lancloudtech.com/api/session', {
      headers: { 'Cf-Access-Jwt-Assertion': 'verified-assertion' },
    });
    const fetcher: typeof fetch = async (input, init) => {
      expect(input.toString()).toBe('https://external-ie-oa.lancloudtech.com/cdn-cgi/access/get-identity');
      expect(new Headers(init?.headers).get('Cf-Access-Jwt-Assertion')).toBe('verified-assertion');
      return new Response(JSON.stringify({ idp: { type: 'github' } }), { status: 200 });
    };
    await expect(resolveAccessProviderHint(request, fetcher)).resolves.toBe('github');
    await expect(resolveAccessProviderHint(request, async () => (
      new Response(JSON.stringify({ idp: { type: 'unrecognized' } }), { status: 200 })
    ))).resolves.toBeNull();
  });

  it('returns null for non-200, malformed, and failed provider responses', async () => {
    const request = new Request('https://external-ie-oa.lancloudtech.com/api/session', {
      headers: { 'Cf-Access-Jwt-Assertion': 'verified-assertion' },
    });

    await expect(resolveAccessProviderHint(request, async () => (
      new Response(JSON.stringify({ idp: { type: 'github' } }), { status: 201 })
    ))).resolves.toBeNull();
    await expect(resolveAccessProviderHint(request, async () => (
      new Response('{invalid-json', { status: 200 })
    ))).resolves.toBeNull();
    await expect(resolveAccessProviderHint(request, async () => {
      throw new Error('network unavailable');
    })).resolves.toBeNull();
  });
});

describe('resolveAuthenticatedIdentity development mode', () => {
  it('preserves an explicitly supplied development email so corporate-entry tests still receive the same validation boundary', async () => {
    const env: Env = {
      DB: {} as D1Database,
      ENVIRONMENT: 'development',
      DEV_AUTH: '1',
    };
    const entry: AccessEntry = {
      kind: 'corporate',
      hostname: 'ie-oa.lancloudtech.com',
      audience: 'corporate-aud',
      origin: 'https://ie-oa.lancloudtech.com',
    };

    await expect(resolveAuthenticatedIdentity(
      new Request('https://ie-oa.lancloudtech.com/api/session', {
        headers: { 'x-dev-subject': 'local-subject', 'x-dev-email': 'employee@lancloudtech.com' },
      }),
      env,
      entry,
    )).resolves.toEqual({
      issuer: 'dev://local',
      subject: 'local-subject',
      email: 'employee@lancloudtech.com',
    });
  });
});

describe('validateIdentityForEntry', () => {
  const corporateEntry: AccessEntry = {
    kind: 'corporate',
    hostname: 'ie-oa.lancloudtech.com',
    audience: 'corporate-aud',
    origin: 'https://ie-oa.lancloudtech.com',
  };
  const externalEntry: AccessEntry = {
    kind: 'external',
    hostname: 'external-ie-oa.lancloudtech.com',
    audience: 'external-aud',
    origin: 'https://external-ie-oa.lancloudtech.com',
  };
  const legacyEntry: AccessEntry = {
    kind: 'legacy',
    hostname: 'ie_oa.lancloudtech.com',
    audience: 'corporate-aud',
    origin: '',
  };

  it.each([
    ['企业', corporateEntry],
    ['旧版企业', legacyEntry],
  ])('%s入口拒绝缺少、非企业及伪造企业域后缀邮箱的已验证身份', (_name, entry) => {
    for (const email of [undefined, 'person@example.com', 'person@lancloudtech.com.evil']) {
      expect(() =>
        validateIdentityForEntry(
          { issuer: 'https://team.cloudflareaccess.com', subject: 'verified-subject', ...(email ? { email } : {}) },
          entry,
        ),
      ).toThrow('corporate Access identity requires a lancloudtech.com email');
    }
  });

  it('在企业入口拒绝伪造企业域后缀邮箱的已验证身份', () => {
    expect(() =>
      validateIdentityForEntry(
        {
          issuer: 'https://team.cloudflareaccess.com',
          subject: 'verified-subject',
          email: 'person@lancloudtech.com.evil',
        },
        corporateEntry,
      ),
    ).toThrow('corporate Access identity requires a lancloudtech.com email');
  });

  it('在企业入口允许精确企业邮箱的已验证身份', () => {
    const identity = {
      issuer: 'https://team.cloudflareaccess.com',
      subject: 'verified-subject',
      email: 'person@lancloudtech.com',
    };
    expect(validateIdentityForEntry(identity, corporateEntry)).toBe(identity);
  });

  it('在外部入口允许任何已验证邮箱', () => {
    const identity = {
      issuer: 'https://team.cloudflareaccess.com',
      subject: 'verified-subject',
      email: 'person@example.com',
    };
    expect(validateIdentityForEntry(identity, externalEntry)).toBe(identity);
  });
});
