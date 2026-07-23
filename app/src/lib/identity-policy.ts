import type { AccessEntryKind } from './access-entry';

export type IdentityKind = 'corporate_primary' | 'legacy_primary';

/** Entry authorization depends only on the persisted identity kind, never email or provider. */
export function canUseIdentityAtEntry(_entry: AccessEntryKind, identityKind: IdentityKind): boolean {
  return identityKind === 'corporate_primary';
}
