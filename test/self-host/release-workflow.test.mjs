/**
 * .github/workflows/release.yml structure (feature 060, T022, FR-010 to
 * FR-012, FR-025, FR-026, contracts/release-workflow.md). The workflow runs
 * only in GitHub Actions; this Docker-free test pins its shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ROOT } from './helpers.mjs';

const text = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
const wf = yaml.load(text);
// js-yaml parses the bare key `on` as the string 'on' (YAML 1.2 core schema).
const on = wf.on ?? wf[true];
const jobs = wf.jobs;
const runText = (job) => (jobs[job].steps || []).map((s) => s.run || '').join('\n');
const usesOf = (job) => (jobs[job].steps || []).map((s) => s.uses).filter(Boolean);

test('triggers: v* tags and manual dispatch with the two inputs, never a branch push', () => {
  assert.deepEqual(Object.keys(on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(on.push, { tags: ['v*'] });
  assert.equal(on.push.branches, undefined);
  const inputs = on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ['allow_single_arch', 'publish']);
  for (const k of ['publish', 'allow_single_arch']) {
    assert.equal(inputs[k].type, 'boolean');
    assert.equal(inputs[k].default, false);
  }
});

test('permissions: read-only at the top, write scopes only on publish (review M3)', () => {
  assert.deepEqual(wf.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'publish') continue;
    assert.equal(job.permissions, undefined, `${name} inherits the read-only default`);
  }
  assert.deepEqual(jobs.publish.permissions, { contents: 'write', packages: 'write' });
});

test('every run step uses bash, which GitHub runs with -eo pipefail (review M2)', () => {
  assert.deepEqual(wf.defaults, { run: { shell: 'bash' } });
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.defaults, undefined, `${name} keeps the workflow default`);
    for (const step of job.steps || []) {
      if (step.run) assert.ok(step.shell === undefined || step.shell === 'bash', `${name}: ${step.name} shell ${step.shell}`);
    }
  }
  // The piped steps the review named: a failing validate must fail the step.
  assert.match(runText('validate'), /release\.mjs validate [^\n]*\| tee -a "\$GITHUB_OUTPUT"/);
});

test('concurrency', () => {
  assert.equal(wf.concurrency.group, 'release-${{ github.ref }}');
  assert.equal(wf.concurrency['cancel-in-progress'], false);
});

test('job graph', () => {
  assert.deepEqual(Object.keys(jobs).sort(), ['agent', 'build-amd64', 'build-arm64', 'publish', 'validate']);
  assert.equal(jobs['build-amd64'].needs, 'validate');
  assert.equal(jobs['build-arm64'].needs, 'validate');
  assert.deepEqual(jobs.agent.needs, ['validate', 'build-amd64']);
  assert.deepEqual([...jobs.publish.needs].sort(), ['agent', 'build-amd64', 'build-arm64', 'validate']);
  assert.equal(jobs['build-amd64']['runs-on'], 'ubuntu-latest');
  assert.equal(jobs['build-arm64']['runs-on'], 'ubuntu-24.04-arm');
  assert.equal(jobs['build-arm64'].if, "needs.validate.outputs.arm64 == 'true'");
});

test('validate uses release.mjs validate and stamp, and decides publish and arm64', () => {
  const run = runText('validate');
  assert.match(run, /node distribution\/self-host\/release\.mjs validate --tag "\$TAG" --github-repository "\$GITHUB_REPOSITORY"/);
  assert.match(run, /TAG="v0\.0\.0-ci\.\$RUN_NUMBER"/);
  assert.match(run, /node distribution\/self-host\/release\.mjs stamp --version "\$VERSION" --out assets/);
  assert.match(run, /sha256sum -c SHA256SUMS/);
  assert.match(run, /never publishes/);
  assert.match(run, /arm64 runners are not available to private repositories/);
  assert.deepEqual(Object.keys(jobs.validate.outputs).sort(), ['arm64', 'image', 'prerelease', 'publish', 'version']);
  const gates = jobs.validate.steps.find((s) => s.id === 'gates');
  assert.equal(gates.env.REPO_PRIVATE, '${{ github.event.repository.private }}');
  assert.equal(gates.env.INPUT_PUBLISH, '${{ inputs.publish }}');
});

for (const [job, arch] of [['build-amd64', 'amd64'], ['build-arm64', 'arm64']]) {
  test(`${job}: native build, smoke steps, and the saved tarball`, () => {
    const run = runText(job);
    assert.match(run, new RegExp(`docker buildx build --platform linux/${arch} --load`));
    assert.match(run, /org\.opencontainers\.image\.source=https:\/\/github\.com\//);
    assert.match(run, /docker compose up -d --wait --wait-timeout 300/);
    // The AGENTS.md form, with no -T and no terminal (RBD-060-23).
    assert.match(run, /^\s*docker compose exec app squire doctor --json > doctor\.json$/m);
    assert.match(run, /d\.ok!==true/);
    assert.match(run, /require\('isolated-vm'\)/);
    assert.match(run, /evalSync\('1\+1'\)/);
    assert.match(run, /curl -fsS http:\/\/127\.0\.0\.1:3910\/self-host\.md \| cmp - AGENTS\.md/);
    assert.match(run, /curl -fsS http:\/\/127\.0\.0\.1:3910\/install\.sh \| cmp - distribution\/self-host\/install\.sh/);
    const teardown = jobs[job].steps.find((s) => /teardown/i.test(s.name));
    assert.equal(teardown.if, 'always()');
    assert.match(teardown.run, /docker compose logs app/);
    assert.match(teardown.run, /docker compose down -v/);
    assert.match(run, new RegExp(`docker save "\\$IMAGE:\\$VERSION" -o image-${arch}\\.tar`));
  });
}

test('agent: loads the candidate, serves assets locally, runs install.sh and the driver', () => {
  const run = runText('agent');
  assert.match(run, /docker load -i image-amd64\.tar/);
  assert.match(run, /python3 -m http\.server 8000 --directory assets/);
  const install = jobs.agent.steps.find((s) => /install\.sh/.test(s.run || ''));
  assert.equal(install.env.SQUIRE_INSTALL_ASSET_URL, 'http://127.0.0.1:8000');
  assert.match(install.run, /sh distribution\/self-host\/install\.sh --dir "\$INSTALL_DIR" --version "\$VERSION"/);
  assert.match(install.run, /--name "CI Agent" --email "ci-agent@example\.com"/);
  assert.match(run, /node test\/first-run\/oauth-chain-driver\.mjs --server http:\/\/localhost:3910/);
  assert.match(run, /--signin-link "\$\(tail -n 1 link\.txt\)"/);
  assert.match(run, /--expect-name "CI Agent" --expect-email "ci-agent@example\.com" --script-check/);
  const teardown = jobs.agent.steps.find((s) => /teardown/i.test(s.name));
  assert.equal(teardown.if, 'always()');
});

test('publish: guarded, checks every gate, pushes tested bytes, latest only for releases, verifies', () => {
  const p = jobs.publish;
  assert.match(p.if, /always\(\)/);
  assert.match(p.if, /needs\.validate\.outputs\.publish == 'true'/);
  assert.match(p.if, /needs\.validate\.result == 'success'/);
  const gate = p.steps[0];
  assert.match(gate.name, /gate/i);
  assert.equal(gate.env.AMD64, '${{ needs.build-amd64.result }}');
  assert.equal(gate.env.ARM64, '${{ needs.build-arm64.result }}');
  assert.equal(gate.env.AGENT, '${{ needs.agent.result }}');
  assert.equal(gate.env.ALLOW_SINGLE_ARCH, '${{ inputs.allow_single_arch }}');
  assert.match(gate.run, /exit 1/);
  const run = runText('publish');
  assert.match(run, /docker tag "\$IMAGE:\$VERSION" "\$IMAGE:\$VERSION-\$arch"/);
  assert.match(run, /docker buildx imagetools create/);
  // Review L2: latest moves only for the highest X.Y.Z release.
  const latest = p.steps.find((s) => s.id === 'latest');
  assert.ok(latest, 'a step decides latest');
  assert.match(latest.run, /git ls-remote --tags origin > ls-remote\.txt/);
  assert.match(latest.run, /node distribution\/self-host\/release\.mjs latest --version "\$VERSION" --ls-remote ls-remote\.txt \| tee -a "\$GITHUB_OUTPUT"/);
  const idx = (re) => p.steps.findIndex((s) => re.test(s.name || ''));
  assert.ok(idx(/Checkout/) < p.steps.indexOf(latest), 'checkout before the latest decision');
  assert.ok(idx(/Set up Node/) < p.steps.indexOf(latest), 'node before the latest decision');
  const manifest = p.steps.find((s) => /manifest/i.test(s.name) && /imagetools create/.test(s.run || ''));
  assert.equal(manifest.env.LATEST, '${{ steps.latest.outputs.latest }}');
  assert.match(manifest.run, /if \[ "\$LATEST" = "true" \]; then tags="\$tags -t \$IMAGE:latest"; fi/);
  assert.ok(!/PRERELEASE" = "false"/.test(run), 'latest no longer follows prerelease alone');
  const release = p.steps.find((s) => /gh release create/.test(s.run || ''));
  assert.equal(release.env.LATEST, '${{ steps.latest.outputs.latest }}');
  assert.match(release.run, /flags="--latest=\$LATEST"/);
  assert.match(run, /docker buildx imagetools inspect --raw/);
  assert.match(run, /gh release create "v\$VERSION"/);
  assert.match(run, /--prerelease/);
  assert.match(run, /test "\$names" = "SHA256SUMS,compose\.yml,env\.example,squire"/);
  assert.ok(!/docker buildx build/.test(run), 'publish never rebuilds');
});

test('no step uses a development endpoint', () => {
  assert.ok(!text.includes('/auth/dev-login'));
  assert.ok(!text.includes('dev-consent-approve'));
  assert.ok(!text.includes('ENABLE_DEV_ENDPOINTS'));
});

test('every action is pinned to a full commit SHA with its version tag in a comment (review M4)', () => {
  let count = 0;
  for (const job of Object.keys(jobs)) {
    for (const u of usesOf(job)) {
      assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${job}: ${u}`);
      count++;
    }
  }
  assert.ok(count > 0);
  const usesLines = text.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l));
  assert.equal(usesLines.length, count, 'every uses: line is a step uses');
  const shaOf = new Map();
  for (const l of usesLines) {
    const m = /uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(l);
    assert.ok(m, `SHA plus a trailing # vX.Y.Z comment: ${l.trim()}`);
    const key = `${m[1]}@${m[3]}`;
    // One action version resolves to one SHA everywhere it is used.
    if (shaOf.has(key)) assert.equal(shaOf.get(key), m[2], key);
    shaOf.set(key, m[2]);
  }
});

test('job-level env uses only contexts GitHub allows there (no runner context)', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const v of Object.values(job.env || {})) {
      assert.ok(!/\brunner\./.test(String(v)), `${name}: ${v}`);
    }
  }
});

test('test.yml runs the self-host suite and shellcheck in the client job, triggers unchanged', () => {
  const t = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8'));
  const tOn = t.on ?? t[true];
  assert.deepEqual(tOn, { push: { branches: ['*'] } });
  const runs = t.jobs.client.steps.map((s) => s.run || '').join('\n');
  assert.match(runs, /npm run test:self-host/);
  assert.match(runs, /shellcheck -s sh distribution\/self-host\/install\.sh distribution\/self-host\/squire/);
  assert.deepEqual(Object.keys(t.jobs).sort(), ['backend', 'client']);
});
