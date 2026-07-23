import { describe, expect, it } from 'vitest';
import { canUseIdentityAtEntry } from '../src/lib/identity-policy';

describe('identity policy', () => {
  it('allows only corporate principals at corporate/legacy entries', () => {
    expect(canUseIdentityAtEntry('corporate', 'corporate_primary')).toBe(true);
    expect(canUseIdentityAtEntry('legacy', 'corporate_primary')).toBe(true);
    expect(canUseIdentityAtEntry('corporate', 'legacy_primary')).toBe(false);
    expect(canUseIdentityAtEntry('legacy', 'legacy_primary')).toBe(false);
  });
});
