# Promotion notes - 058-self-host-config

Records prototype relaxations owed at promotion and, after merge, the
post-merge review dispositions. Started at spec time; nothing is reviewed
yet.

## Relaxations accepted at spec time

- Image bytes are not migrated between storage drivers (spec, Assumptions).
  An operator who switches `STORAGE_DRIVER` with existing rows gets 404 for
  those rows. A migration script is follow-on work if anyone needs it.
- The `documentation/*.md` pages keep their squiredocs.com mentions until
  feature 060's documentation work (RBD-058-6).
- The assistant panel's "how to add a key" message for a keyless instance is
  not built here; the design assigns it to no step (spec, Design gaps, item 8).
- Admin page credit editing stays visible when not hosted even though the
  allowance is not enforced there (RBD-058-3).

## Verification owed before the first hosted deploy

- The four overlay values in the spec's Hosted Deploy Checklist.
- The minikube `collab-app` secrets must be strong, non-default values
  (RBD-058-15).

## Review dispositions

(none yet)
