/**
 * Feature 059 (T059, FR-025, RBD-059-1/-11/-15): every deployment this repo
 * ships sets SQUIRE_MODE=team explicitly. Unset means local mode (design D1),
 * which turns Google sign-in off, so a future edit that drops the entry from
 * the hosted overlay would lock everyone out of squiredocs.com. This pins it.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');

function containerEnv(doc) {
  const containers = doc?.spec?.template?.spec?.containers || [];
  return containers.flatMap((c) => c.env || []);
}

function squireModeIn(file) {
  const docs = yaml.loadAll(fs.readFileSync(path.join(ROOT, file), 'utf8')).filter(Boolean);
  const values = docs.flatMap(containerEnv).filter((e) => e.name === 'SQUIRE_MODE').map((e) => e.value);
  return values;
}

describe('deployments set SQUIRE_MODE=team', () => {
  test.each([
    'k8s/base/app-deployment.yaml',
    'k8s/overlays/aws-prod/patches/app-node-env.yaml',
    'k8s/overlays/minikube/app-dev.yaml',
    'devcontainer/k8s/app-dev.yaml',
  ])('%s', (file) => {
    expect(squireModeIn(file)).toEqual(['team']);
  });

  test('.env.example', () => {
    const src = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    expect(src).toMatch(/^SQUIRE_MODE=team$/m);
  });
});
