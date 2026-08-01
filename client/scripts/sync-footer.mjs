/**
 * sync-footer.mjs — stamp the canonical footer (scripts/site-footer.mjs) into
 * the static marketing pages in public/. Runs at the start of `npm run build`
 * so the shipped pages can never drift from the source of truth; run it
 * manually after editing site-footer.mjs to update the checked-in files.
 *
 *   node scripts/sync-footer.mjs           # rewrite the pages in place
 *   node scripts/sync-footer.mjs --check   # exit 1 if any page is out of sync
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { syncFooterIntoHtml } from './site-footer.mjs';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGES = ['landing.html', 'pricing.html', 'about.html', 'security.html'];
const check = process.argv.includes('--check');

let drifted = [];
for (const name of PAGES) {
  const file = path.join(publicDir, name);
  const before = fs.readFileSync(file, 'utf8');
  const after = syncFooterIntoHtml(before);
  if (after === before) continue;
  drifted.push(name);
  if (!check) fs.writeFileSync(file, after);
}

if (check && drifted.length) {
  console.error(`sync-footer --check FAILED: out of sync with scripts/site-footer.mjs: ${drifted.join(', ')}`);
  console.error('Run `npm run sync:footer` (in client/) and commit the result.');
  process.exit(1);
}
console.log(drifted.length
  ? `sync-footer — updated: ${drifted.join(', ')}`
  : 'sync-footer — all pages in sync');
