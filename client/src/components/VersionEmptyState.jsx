/**
 * The "there is nothing to show" copy for version history.
 *
 * Two surfaces render this, under different conditions and inside different
 * wrapper classes: the PANEL when the whole timeline is empty
 * (`.version-history-empty` / `-empty-hint`), and the LIST when versions exist
 * but the "named only" filter matches none of them (`.hierarchy-empty-state` /
 * `.hierarchy-empty-hint`). Both are live.
 *
 * Feature 042 (FR-012) deduplicated the COPY, which had been maintained twice
 * and byte-identically. It deliberately did NOT unify the class names: the two
 * stylesheets key on them, and collapsing them would be a rendered-output
 * change (contract C6). So the classes are parameters.
 *
 * @param {'all'|'named'} filter - which filter the surface is showing
 * @param {string} className - wrapper class for this surface
 * @param {string} hintClassName - class for the second, quieter line
 */
function VersionEmptyState({ filter, className, hintClassName }) {
  const named = filter === 'named';
  return (
    <div className={className}>
      <p>{named ? 'No named versions yet.' : 'No version history yet.'}</p>
      <p className={hintClassName}>
        {named
          ? 'Name a version using the menu on any version.'
          : 'Edit the document to start tracking versions.'}
      </p>
    </div>
  );
}

export default VersionEmptyState;
