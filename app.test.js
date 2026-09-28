'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp, loadStore, makeToken, readToken } = require('./app');

function request(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('personalisierter Link speichert die Abmeldung erst nach POST und benachrichtigt einmal', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'optouts.json');
  const key = crypto.randomBytes(32);
  const sent = [];
  const { handler } = createApp({ key, file, notify: async (...args) => { sent.push(args); } });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const token = makeToken('Person+1@example.org', key);
  const url = `/abmelden/${token}`;

  assert.equal((await request(port, 'GET', '/health')).status, 200);
  assert.equal(readToken(token, key), 'Person+1@example.org');
  assert.throws(() => readToken(`${token}x`, key));
  const landing = await request(port, 'GET', url);
  assert.equal(landing.status, 200);
  assert.match(landing.body, /Person\+1@example.org/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(sent.length, 0);

  const confirmed = await request(port, 'POST', url);
  assert.equal(confirmed.status, 303);
  assert.equal(confirmed.headers.location, `${url}/fertig`);
  await new Promise(resolve => setImmediate(resolve));
  const store = loadStore(file);
  assert.equal(store.optouts['person+1@example.org'].email, 'Person+1@example.org');
  assert.ok(store.optouts['person+1@example.org'].notifiedAt);
  assert.equal(sent.length, 1);

  assert.equal((await request(port, 'POST', url)).status, 303);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal((await request(port, 'GET', `${url}/fertig`)).status, 200);
});

test('gespeicherte Abmeldung bleibt bei Mailfehler bestehen und kann erneut gemeldet werden', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'optout-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'optouts.json');
  const key = crypto.randomBytes(32);
  let attempts = 0;
  const logger = { error() {} };
  const app = createApp({ key, file, logger, notify: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('SMTP nicht erreichbar');
  } });
  const server = http.createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `/abmelden/${makeToken('beispiel@example.org', key)}`;

  assert.equal((await request(server.address().port, 'POST', url)).status, 303);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadStore(file).optouts['beispiel@example.org'].notifiedAt, null);
  await app.retryPending();
  assert.equal(attempts, 2);
  assert.ok(loadStore(file).optouts['beispiel@example.org'].notifiedAt);
});
