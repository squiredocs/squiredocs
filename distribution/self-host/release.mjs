#!/usr/bin/env node
/**
 * release.mjs: release-tag validation and asset stamping for the self-host
 * distribution (feature 060, research R1/R2/R6, contracts/compose-and-assets.md).
 *
 * REPOSITORY is the one definition of the GitHub repository and GHCR image
 * name. Four files carry it as a literal because they are served or published
 * verbatim (AGENTS.md, install.sh, compose.yml, documentation/self-hosting.md);
 * test/self-host/repository-constant.test.mjs fails if any of them drifts.
 * Sam named the public repository squiredocs/squiredocs on 2026-10-07
 * (RBD-060-1). The placeholder '<org>/<repo>' it replaced is still refused by
 * install.sh and `validate`, and `validate` refuses to publish from any other
 * repository (RBD-060-20), so a run in a private or forked repository stays
 * inert. Changing it is a find-and-replace across the four files and this one.
 *
 * CLI (used by .github/workflows/release.yml):
 *   node distribution/self-host/release.mjs validate --tag vX.Y.Z --github-repository owner/name
 *     stdout: version=X.Y.Z, prerelease=true|false, image=ghcr.io/<repo>   (exit 0)
 *     stderr: one message naming the problem                              (exit 1)
 *   node distribution/self-host/release.mjs stamp --version X.Y.Z --out DIR
 *     writes compose.yml, squire, env.example, SHA256SUMS                  (exit 0/1)
 *   node distribution/self-host/release.mjs latest --version X.Y.Z --ls-remote FILE
 *     FILE is `git ls-remote --tags origin` output. stdout: latest=true when
 *     X.Y.Z is a release (not a prerelease) and no vA.B.C release tag in FILE
 *     is higher, else latest=false, so a backport never moves `latest` back.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'squiredocs/squiredocs';
export const VERSION_TOKEN = '__SQUIRE_VERSION__';
export const ASSET_NAMES = ['compose.yml', 'squire', 'env.example', 'SHA256SUMS'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

// vX.Y.Z with an optional prerelease suffix. Build metadata (+...) is
// rejected because image tags cannot carry '+'.
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const REPO_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9._-]+$/;

/** @returns {{ version: string, prerelease: boolean }} */
export function parseReleaseTag(tag) {
  const m = TAG_RE.exec(String(tag || ''));
  if (!m) {
    throw new Error(`Tag ${JSON.stringify(tag)} is not a release tag. Use vX.Y.Z or vX.Y.Z-prerelease, for example v1.2.3 or v1.2.3-rc.1.`);
  }
  return { version: String(tag).slice(1), prerelease: Boolean(m[4]) };
}

/**
 * Refuse a placeholder or malformed repository name, and (when given) one
 * that differs from the GitHub repository running the workflow. GitHub
 * repository names compare case-insensitively; REPOSITORY itself must be
 * lowercase because GHCR image names are.
 */
export function validateRepository(repo, githubRepository) {
  const r = String(repo || '');
  if (/[<>]/.test(r) || r.includes('<org>') || r.includes('<repo>')) {
    throw new Error(`REPOSITORY in distribution/self-host/release.mjs is still the placeholder ${r}. Set it to the real owner/name in the five files that carry it before releasing.`);
  }
  if (!REPO_RE.test(r)) {
    throw new Error(`REPOSITORY ${JSON.stringify(r)} is not a lowercase owner/name. Fix it in distribution/self-host/release.mjs and the four files that mirror it.`);
  }
  if (githubRepository !== undefined && r !== String(githubRepository).toLowerCase()) {
    throw new Error(`REPOSITORY is ${r} but this workflow runs in ${githubRepository}. A release publishes only from the repository REPOSITORY names.`);
  }
}

/** Release tag names (vX.Y.Z...) from `git ls-remote --tags` output; peeled ^{} lines fold into their tag. */
export function tagsFromLsRemote(text) {
  const tags = new Set();
  for (const line of String(text).split('\n')) {
    const ref = line.trim().split(/\s+/).pop() || '';
    const m = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
    if (m) tags.add(m[1]);
  }
  return [...tags];
}

/**
 * Whether `version` should carry the `latest` image tag and GitHub's Latest
 * badge: it is a release (no prerelease suffix) and no release tag in `tags`
 * is a higher X.Y.Z. Prerelease and malformed tags in `tags` are ignored.
 */
export function isHighestRelease(version, tags) {
  const m = VERSION_RE.exec(String(version || ''));
  if (!m) throw new Error(`Version ${JSON.stringify(version)} is not X.Y.Z (no leading v).`);
  if (m[4]) return false;
  const mine = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const tag of tags) {
    const t = TAG_RE.exec(tag);
    if (!t || t[4]) continue;
    const other = [Number(t[1]), Number(t[2]), Number(t[3])];
    for (let i = 0; i < 3; i++) {
      if (other[i] > mine[i]) return false;
      if (other[i] < mine[i]) break;
    }
  }
  return true;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Write the four release assets for `version` into `outDir`, then re-read them
 * and fail if any version token or repository placeholder remains.
 * @returns {{ files: string[] }}
 */
export function stampAssets({ version, outDir, srcDir = HERE }) {
  if (!VERSION_RE.test(String(version || ''))) {
    throw new Error(`Version ${JSON.stringify(version)} is not X.Y.Z (no leading v).`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = (text) => text.split(VERSION_TOKEN).join(version);

  fs.writeFileSync(path.join(outDir, 'compose.yml'), stamp(fs.readFileSync(path.join(srcDir, 'compose.yml'), 'utf8')));
  fs.copyFileSync(path.join(srcDir, 'squire'), path.join(outDir, 'squire'));
  fs.chmodSync(path.join(outDir, 'squire'), 0o755);
  // Published as env.example: GitHub renames release assets whose names start
  // with a period (RBD-060-21). install.sh saves it as .env.example.
  fs.writeFileSync(path.join(outDir, 'env.example'), stamp(fs.readFileSync(path.join(srcDir, '.env.example'), 'utf8')));

  const summed = ['compose.yml', 'squire', 'env.example'];
  const sums = summed.map((name) => `${sha256(path.join(outDir, name))}  ${name}\n`).join('');
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sums);

  for (const name of ASSET_NAMES) {
    const text = fs.readFileSync(path.join(outDir, name), 'utf8');
    for (const bad of ['__SQUIRE_', '<org>', '<repo>']) {
      if (text.includes(bad)) {
        throw new Error(`${name} still contains ${bad} after stamping. Set REPOSITORY and check the version token.`);
      }
    }
  }
  return { files: [...ASSET_NAMES] };
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${JSON.stringify(a)}.`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value.`);
    flags[a.slice(2)] = v;
    i++;
  }
  return flags;
}

/** CLI entry. @returns {number} exit code */
export function cli(argv, { out = process.stdout, err = process.stderr, repository = REPOSITORY, srcDir = HERE } = {}) {
  const [cmd, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    if (cmd === 'validate') {
      if (!flags.tag || !flags['github-repository']) {
        throw new Error('Usage: release.mjs validate --tag vX.Y.Z --github-repository owner/name');
      }
      const { version, prerelease } = parseReleaseTag(flags.tag);
      validateRepository(repository, flags['github-repository']);
      out.write(`version=${version}\nprerelease=${prerelease}\nimage=ghcr.io/${repository}\n`);
      return 0;
    }
    if (cmd === 'stamp') {
      if (!flags.version || !flags.out) throw new Error('Usage: release.mjs stamp --version X.Y.Z --out DIR');
      validateRepository(repository);
      const { files } = stampAssets({ version: flags.version, outDir: flags.out, srcDir });
      err.write(`Stamped ${files.join(', ')} for ${flags.version} in ${flags.out}\n`);
      return 0;
    }
    if (cmd === 'latest') {
      if (!flags.version || !flags['ls-remote']) throw new Error('Usage: release.mjs latest --version X.Y.Z --ls-remote FILE');
      const tags = tagsFromLsRemote(fs.readFileSync(flags['ls-remote'], 'utf8'));
      out.write(`latest=${isHighestRelease(flags.version, tags)}\n`);
      return 0;
    }
    throw new Error('Usage: release.mjs validate|stamp|latest ...');
  } catch (e) {
    err.write(`${e.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = cli(process.argv.slice(2));
}
