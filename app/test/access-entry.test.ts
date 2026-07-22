import { describe, expect, it } from 'vitest';
import {
  accessEntryForRequest,
  isAllowedEntryOrigin,
  isCorporateEmail,
} from '../src/lib/access-entry';
import type { Env } from '../src/lib/types';

const env = {
  ACCESS_AUD_CORPORATE: 'corporate-aud',
  ACCESS_AUD_EXTERNAL: 'external-aud',
} as Env;

describe('accessEntryForRequest', () => {
  it('只接受精确匹配的企业、外部和旧入口 host', () => {
    expect(accessEntryForRequest('ie-oa.lancloudtech.com', env)?.kind).toBe('corporate');
    expect(accessEntryForRequest('external-ie-oa.lancloudtech.com', env)?.audience).toBe('external-aud');
    expect(accessEntryForRequest('ie_oa.lancloudtech.com', env)?.kind).toBe('legacy');
    expect(accessEntryForRequest('evil.lancloudtech.com', env)).toBeNull();
  });

  it('忽略 host 大小写和端口，但不接受子域近似匹配', () => {
    expect(accessEntryForRequest('IE-OA.LANCLOUDTECH.COM:443', env)?.kind).toBe('corporate');
    expect(accessEntryForRequest('random.ie-oa.lancloudtech.com', env)).toBeNull();
  });
});

describe('isCorporateEmail', () => {
  it('仅接受精确的企业邮箱域', () => {
    expect(isCorporateEmail('  Employee@LanCloudTech.com ')).toBe('employee@lancloudtech.com');
    expect(isCorporateEmail('employee@lancloudtech.com.evil')).toBeNull();
  });
});

describe('isAllowedEntryOrigin', () => {
  it('只接受入口自身的精确 mutation origin', () => {
    const corporateEntry = accessEntryForRequest('ie-oa.lancloudtech.com', env)!;

    expect(isAllowedEntryOrigin('https://ie-oa.lancloudtech.com', corporateEntry)).toBe(true);
    expect(isAllowedEntryOrigin('https://random.ie-oa.lancloudtech.com', corporateEntry)).toBe(false);
  });
});
