/**
 * Feature 058: a temp client build directory for mounting the production
 * server/web-routes.js in tests (web-routes.test.js, hosted-parity.test.js).
 * index.html is the REAL client/index.html source, so shell injection is tested
 * against the actual file; every other page is a small stub.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_INDEX = path.join(__dirname, '../../../client/index.html');
const REAL_AGENTS = path.join(__dirname, '../../../client/public/agents.md');

function createClientBuildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-client-build-'));
  const write = (rel, body) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  write('index.html', fs.readFileSync(REAL_INDEX, 'utf8'));
  write('landing.html', '<html><body>LANDING PAGE</body></html>');
  write('pricing.html', '<html><body>PRICING PAGE</body></html>');
  write('about.html', '<html><body>ABOUT PAGE</body></html>');
  write('security.html', '<html><body>SECURITY PAGE</body></html>');
  write('agents.md', fs.readFileSync(REAL_AGENTS, 'utf8'));
  write('blog.css', 'body{}');
  write('marketing.css', 'body{}');
  write('assets/app.js', 'console.log(1)');
  write('documentation/index.html', '<html><body>DOCS INDEX</body></html>');
  write('documentation/agents-and-mcp.html', '<html><body>AGENTS AND MCP</body></html>');
  write('documentation/404.html', '<html><body>DOCS 404</body></html>');
  write('blog/index.html', '<html><body>BLOG INDEX</body></html>');
  write('blog/404.html', '<html><body>BLOG 404</body></html>');
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { createClientBuildFixture, REAL_AGENTS };
