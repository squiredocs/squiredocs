/**
 * Build script for the isolate bundle
 *
 * Bundles isolate-entry.js with all dependencies (yjs, fontoxpath, helpers, etc.)
 * into a single IIFE file that can be loaded inside an isolated-vm isolate.
 *
 * Usage: node server/mcp/sandbox/build-isolate-bundle.js
 *    or: npm run build:sandbox-bundle
 */

const { buildSync } = require('esbuild');
const path = require('path');

const result = buildSync({
  entryPoints: [path.join(__dirname, 'isolate-entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  mainFields: ['main', 'module'],
  outfile: path.join(__dirname, 'isolate-bundle.js'),
  logLevel: 'info',
});
