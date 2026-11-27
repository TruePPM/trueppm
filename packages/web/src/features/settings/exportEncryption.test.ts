import { describe, expect, it } from 'vitest';
import {
  bundleFilename,
  EMPTY_ENCRYPTION_DRAFT,
  encryptionLabel,
  encryptionProblem,
  exportStartBody,
} from './exportEncryption';

// The public recipient from the age spec examples: a public key, not a secret.
const AGE_RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

describe('exportEncryption (issue 2400)', () => {
  it('is off by default and sends an empty body', () => {
    expect(encryptionProblem(EMPTY_ENCRYPTION_DRAFT)).toBeNull();
    expect(exportStartBody(EMPTY_ENCRYPTION_DRAFT)).toEqual({});
  });

  it('blocks a passphrase until it is long enough, confirmed and acknowledged', () => {
    const base = { ...EMPTY_ENCRYPTION_DRAFT, choice: 'passphrase' as const };
    expect(encryptionProblem({ ...base, passphrase: 'short' })).toMatch(/at least 12/);
    const long = { ...base, passphrase: 'correct horse battery' };
    expect(encryptionProblem({ ...long, confirm: 'nope' })).toMatch(/don’t match/);
    const confirmed = { ...long, confirm: long.passphrase };
    expect(encryptionProblem(confirmed)).toMatch(/keep the passphrase safe/);
    const ready = { ...confirmed, acknowledged: true };
    expect(encryptionProblem(ready)).toBeNull();
    expect(exportStartBody(ready)).toEqual({
      encryption: { mode: 'passphrase', passphrase: 'correct horse battery' },
    });
  });

  it('accepts only an age public key and refuses a pasted secret key', () => {
    const base = { ...EMPTY_ENCRYPTION_DRAFT, choice: 'recipient' as const };
    expect(encryptionProblem({ ...base, recipient: 'age1nope' })).toMatch(/age public key/);
    expect(encryptionProblem({ ...base, recipient: 'AGE-SECRET-KEY-1ABC' })).toMatch(/secret key/);
    const ready = { ...base, recipient: `  ${AGE_RECIPIENT}\n` };
    expect(encryptionProblem(ready)).toBeNull();
    expect(exportStartBody(ready)).toEqual({
      encryption: { mode: 'recipient', recipient: AGE_RECIPIENT },
    });
  });

  it('names an encrypted download so it never looks like a plain archive', () => {
    expect(bundleFilename('project-ABC', 'none')).toBe('project-ABC.tar.gz');
    expect(bundleFilename('project-ABC', 'passphrase')).toBe('project-ABC.tar.gz.age');
    expect(encryptionLabel('none')).toBeNull();
    expect(encryptionLabel('recipient')).toMatch(/age public key/);
  });
});
