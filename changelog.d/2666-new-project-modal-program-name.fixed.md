- **New project modal now names the program it attaches to.** The shell's global
  "+ New project" button silently attached the new project to whatever program was
  in route context, without ever naming it in the dialog — the only clue was an
  optional step-3 checkbox that, from that entry point, fell back to the generic
  word "program" because the resolved name was never passed through. The target
  program is now shown as a first-class field on step 1 whenever one is set, and
  the name is threaded through the shell's create-intent dispatch so it can never
  be silently dropped again (#2666).
