/**
 * Opt-in encryption for an export bundle (issue 2400, ADR-0634 §5). Pure state →
 * request-body logic shared by the project and program bundle cards, so the
 * "can the user start this export yet?" rule lives in one tested place.
 *
 * The passphrase is sent once, in the POST body, and the server keeps only a
 * public key derived from it — so the client must make the user acknowledge that
 * a lost passphrase cannot be recovered before the button enables.
 */

export type EncryptionChoice = 'none' | 'passphrase' | 'recipient';

export interface EncryptionDraft {
  choice: EncryptionChoice;
  passphrase: string;
  confirm: string;
  acknowledged: boolean;
  recipient: string;
}

/** Request body of `POST .../export/` (`ExportStartRequest`). */
export type ExportStartBody =
  | Record<string, never>
  | { encryption: { mode: 'passphrase'; passphrase: string } }
  | { encryption: { mode: 'recipient'; recipient: string } };

/** Mirrors the server's `MIN_PASSPHRASE_LENGTH`. */
export const MIN_PASSPHRASE_LENGTH = 12;

export const EMPTY_ENCRYPTION_DRAFT: EncryptionDraft = {
  choice: 'none',
  passphrase: '',
  confirm: '',
  acknowledged: false,
  recipient: '',
};

/**
 * The first reason the draft cannot be submitted, or null when it can. Shown under
 * the fields, so it names the fix rather than the rule.
 */
export function encryptionProblem(draft: EncryptionDraft): string | null {
  if (draft.choice === 'passphrase') {
    if (draft.passphrase.length < MIN_PASSPHRASE_LENGTH) {
      return `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`;
    }
    if (draft.confirm !== draft.passphrase) return 'The two passphrases don’t match.';
    if (!draft.acknowledged) return 'Confirm that you’ll keep the passphrase safe.';
    return null;
  }
  if (draft.choice === 'recipient') {
    const key = draft.recipient.trim();
    if (key.toUpperCase().startsWith('AGE-SECRET-KEY-')) {
      return 'That’s a secret key. Paste the public key (it starts with age1).';
    }
    if (!/^age1[02-9ac-hj-np-z]{58}$/.test(key)) {
      return 'Paste an age public key (it starts with age1).';
    }
    return null;
  }
  return null;
}

/** The POST body for the draft. Call only when `encryptionProblem` is null. */
export function exportStartBody(draft: EncryptionDraft): ExportStartBody {
  if (draft.choice === 'passphrase') {
    return { encryption: { mode: 'passphrase', passphrase: draft.passphrase } };
  }
  if (draft.choice === 'recipient') {
    return { encryption: { mode: 'recipient', recipient: draft.recipient.trim() } };
  }
  return {};
}

/** Download name: an encrypted bundle never looks like a plain `.tar.gz`. */
export function bundleFilename(base: string, encryptionMode: EncryptionChoice): string {
  return encryptionMode === 'none' ? `${base}.tar.gz` : `${base}.tar.gz.age`;
}

/** Status-line suffix for a job, so an encrypted build is obvious before download. */
export function encryptionLabel(encryptionMode: EncryptionChoice | undefined): string | null {
  if (encryptionMode === 'passphrase') return 'Encrypted with a passphrase';
  if (encryptionMode === 'recipient') return 'Encrypted to an age public key';
  return null;
}
