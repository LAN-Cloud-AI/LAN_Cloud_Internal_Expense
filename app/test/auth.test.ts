import { describe, expect, it } from 'vitest';
import {
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

describe('validateIdentityForEntry', () => {
  const corporateEntry: AccessEntry = {
    kind: 'corporate',
    hostname: 'ie-oa.lancloudtech.com',
    audience: 'corporate-aud',
    origin: 'https://ie-oa.lancloudtech.com',
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
  ])('%s入口拒绝缺少或形态非法的已验证邮箱', (_name, entry) => {
    for (const email of [undefined, 'not-an-email', 'person@', '@example.com', 'a@b@c']) {
      expect(() =>
        validateIdentityForEntry(
          { issuer: 'https://team.cloudflareaccess.com', subject: 'verified-subject', ...(email ? { email } : {}) },
          entry,
        ),
      ).toThrow('corporate Access identity requires a verified email');
    }
  });

  it('企业入口允许任意域的合法已验证邮箱（能否开户由登录白名单决定）', () => {
    for (const email of ['person@lancloudtech.com', 'person@example.com']) {
      const identity = {
        issuer: 'https://team.cloudflareaccess.com',
        subject: 'verified-subject',
        email,
      };
      expect(validateIdentityForEntry(identity, corporateEntry)).toBe(identity);
    }
  });

});
