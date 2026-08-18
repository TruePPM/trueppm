/**
 * The one "how do I get an .xml out of MS Project?" recipe.
 *
 * Two surfaces need it — `FormatPicker`'s guidance disclosure (offered *before*
 * you fail) and `ImportModal`'s rejection notice (offered *after*) — and they had
 * drifted: the modal's copy omitted the sentence that Project for the web cannot
 * save XML at all, so a Cloud user reading it would hunt for a Save As → XML
 * option their client does not have (#2892).
 *
 * A component rather than a string constant because the copy is marked up, and
 * emphasis on `File → Save As` / `XML Format (*.xml)` is what makes it scannable.
 */
export function MsProjectXmlRecipe() {
  return (
    <>
      In MS Project (desktop): <strong>File → Save As</strong>, choose{' '}
      <strong>XML Format (*.xml)</strong>, then <strong>Save</strong>. Upload that{' '}
      <code>.xml</code> here. Project for the web can&apos;t save XML — use the desktop app.
    </>
  );
}
