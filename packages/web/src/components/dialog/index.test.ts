import { describe, it, expect } from 'vitest';
import {
  useDirtyDraft,
  DialogFooter,
  useUnsavedChangesGuard,
  UnsavedChangesDialog,
} from './index';

// The barrel is the public entry point for the shared editable-dialog contract
// (web-rule 217); this smoke test keeps it in the coverage report so
// check-added-files-covered.mjs can gate it, and guards against a re-export
// being dropped or renamed.
describe('components/dialog barrel', () => {
  it('re-exports every commit/discard primitive', () => {
    expect(useDirtyDraft).toBeTypeOf('function');
    expect(DialogFooter).toBeTypeOf('function');
    expect(useUnsavedChangesGuard).toBeTypeOf('function');
    expect(UnsavedChangesDialog).toBeTypeOf('function');
  });
});
