/**
 * Feature 058 (T044, RBD-058-4): server/app-shell.js against the real
 * client/index.html source.
 */
const fs = require('fs');
const path = require('path');
const { renderAppShell } = require('../app-shell');

const INDEX = fs.readFileSync(path.join(__dirname, '../../client/index.html'), 'utf8');

test('the source shell carries no analytics tag and no instance flag', () => {
  expect(INDEX).not.toContain('googletagmanager');
  expect(INDEX).not.toContain('gtag(');
  expect(INDEX).not.toContain('<script>window.__SQUIRE_INSTANCE__');
});

test('not hosted: no Google tag, {"hosted":false}', () => {
  const html = renderAppShell(INDEX, { hosted: false });
  expect(html).not.toMatch(/googletagmanager|gtag\(|G-9HGTDJRJWH|AW-18023084061/);
  expect(html).toContain('<script>window.__SQUIRE_INSTANCE__={"hosted":false}</script>');
});

test('hosted: the tag sits immediately after <head>, before any other script', () => {
  const html = renderAppShell(INDEX, { hosted: true });
  const headEnd = html.indexOf('<head>') + '<head>'.length;
  const afterHead = html.slice(headEnd).trimStart();
  expect(afterHead.startsWith('<!-- Google tag (gtag.js) -->')).toBe(true);
  const firstScript = html.indexOf('<script');
  expect(html.indexOf('googletagmanager.com/gtag/js?id=G-9HGTDJRJWH')).toBeGreaterThan(firstScript);
  expect(html.slice(firstScript, firstScript + 120)).toContain('googletagmanager.com/gtag/js?id=G-9HGTDJRJWH');
  expect(html).toContain("gtag('config', 'G-9HGTDJRJWH');");
  expect(html).toContain("gtag('config', 'AW-18023084061');");
  expect(html).toContain('<script>window.__SQUIRE_INSTANCE__={"hosted":true}</script>');
});

test('the theme bootstrap script is preserved', () => {
  for (const hosted of [true, false]) {
    const html = renderAppShell(INDEX, { hosted });
    expect(html).toContain("localStorage.getItem('squire-theme')");
    expect(html).toContain('<script type="module" src="/src/main.jsx"></script>');
  }
});

test('the injected object carries only the hosted flag', () => {
  const html = renderAppShell(INDEX, { hosted: true });
  const m = /window\.__SQUIRE_INSTANCE__=(\{[^<]*\})<\/script>/.exec(html);
  expect(JSON.parse(m[1])).toEqual({ hosted: true });
});

test('a non-boolean hosted value is treated as not hosted', () => {
  const html = renderAppShell(INDEX, { hosted: 'true' });
  expect(html).toContain('{"hosted":false}');
  expect(html).not.toContain('googletagmanager');
});
