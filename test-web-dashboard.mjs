import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const files = ['web/index.html', 'web/app.css', 'web/app.js'];
for (const file of files) {
  const content = await readFile(path.join(root, file), 'utf8');
  assert.ok(content.length > 100, `${file} should not be empty`);
}
const html = await readFile(path.join(root, 'web/index.html'), 'utf8');
assert.match(html, /\/web\/app\.css/);
assert.match(html, /\/web\/app\.js/);
const server = await readFile(path.join(root, 'core/http-server.js'), 'utf8');
assert.match(server, /\/api\/friends\/online/);
assert.match(server, /\/api\/events\/recent/);
assert.match(server, /WEB_DIR/);
console.log('Web dashboard smoke test passed');
