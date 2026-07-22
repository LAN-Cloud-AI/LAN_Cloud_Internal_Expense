import type { AccessEntryKind } from './access-entry';

export type IdentityKind = 'corporate_primary' | 'linked_external' | 'legacy_primary';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generates a 128-bit binding value in unpadded RFC 4648 base32. */
export function createBindingSecret(randomBytes: () => Uint8Array = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytes;
}): string {
  const bytes = randomBytes();
  if (bytes.length !== 16) throw new Error('binding secret requires 16 random bytes');

  let output = '';
  let buffer = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(buffer << (5 - bitCount)) & 31];
  return output;
}

/** Returns a lower-case SHA-256 hex digest; the raw binding secret is never stored. */
export async function hashBindingSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function maskIdentityEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (localPart.length === 1) return `*@${domain}`;
  return `${localPart[0]}${'*'.repeat(Math.max(0, localPart.length - 2))}${localPart.at(-1)}@${domain}`;
}

/** Entry authorization depends only on the persisted identity kind, never email or provider. */
export function canUseIdentityAtEntry(entry: AccessEntryKind, identityKind: IdentityKind): boolean {
  if (entry === 'external') return identityKind === 'linked_external';
  return identityKind === 'corporate_primary';
}
