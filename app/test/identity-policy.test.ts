import { describe, expect, it } from 'vitest';
import {
  canUseIdentityAtEntry,
  createBindingSecret,
  hashBindingSecret,
  maskIdentityEmail,
} from '../src/lib/identity-policy';

describe('identity policy', () => {
  it('creates only a 128-bit base32 binding secret and stores its SHA-256 digest', async () => {
    expect(createBindingSecret(() => new Uint8Array(16).fill(1))).toMatch(/^[A-Z2-7]{26}$/);
    expect(await hashBindingSecret('code')).toHaveLength(64);
  });

  it('masks identity email without losing its domain', () => {
    expect(maskIdentityEmail('personal@example.com')).toBe('p******l@example.com');
    expect(maskIdentityEmail('a@example.com')).toBe('*@example.com');
    expect(maskIdentityEmail(undefined)).toBeNull();
  });

  it('allows only corporate principals at corporate/legacy entries and linked principals at external entry', () => {
    expect(canUseIdentityAtEntry('corporate', 'linked_external')).toBe(false);
    expect(canUseIdentityAtEntry('external', 'corporate_primary')).toBe(false);
    expect(canUseIdentityAtEntry('external', 'linked_external')).toBe(true);
    expect(canUseIdentityAtEntry('external', 'legacy_primary')).toBe(false);
    expect(canUseIdentityAtEntry('legacy', 'legacy_primary')).toBe(false);
  });
});
