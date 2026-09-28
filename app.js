'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { sendNotification } = require('./smtp');

const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'optouts.json');

function emailAddress(value) {
  const email = String(value || '').trim();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email)) {
    throw new Error('Bitte eine gültige E-Mail-Adresse angeben.');
  }
  return email;
}

function normalizedEmail(value) {
  return emailAddress(value).toLowerCase();
}

function secretKey(env = process.env) {
  if (!/^[0-9a-f]{64}$/i.test(env.TOKEN_SECRET || '')) {
    throw new Error('TOKEN_SECRET muss aus 64 Hex-Zeichen bestehen.');
  }
  return Buffer.from(env.TOKEN_SECRET, 'hex');
}

function makeToken(email, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(emailAddress(email), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function readToken(token, key) {
  if (typeof token !== 'string' || token.length > 500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Ungültiger Link.');
  }
  try {
    const [ivText, ciphertextText, tagText] = token.split('.');
    const iv = Buffer.from(ivText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('token length');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return emailAddress(Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8'));
  } catch {
    throw new Error('Ungültiger Link.');
  }
}

function dataFile(env = process.env) {
  return path.resolve(env.DATA_FILE || DEFAULT_DATA_FILE);
}

function loadStore(file) {
  if (!fs.existsSync(file)) return { version: 1, optouts: {} };
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (store.version !== 1 || !store.optouts || typeof store.optouts !== 'object' || Array.isArray(store.optouts)) {
    throw new Error('Die Datendatei hat ein unbekanntes Format.');
  }
  return store;
}

function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function page(title, content) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:18px/1.5 system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.2rem;color:#222}button{font:inherit;padding:.7rem 1rem;cursor:pointer}form{margin-top:2rem}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
}

function respond(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    ...extra,
  });
  res.end(body);
}

function createApp({ key, file, notify = sendNotification, logger = console }) {
  const inFlight = new Set();

  async function deliverPending(emailKey) {
    if (inFlight.has(emailKey)) return;
    const record = loadStore(file).optouts[emailKey];
    if (!record || record.notifiedAt) return;
    inFlight.add(emailKey);
    try {
      await notify(record.email, record.requestedAt);
      const store = loadStore(file);
      if (store.optouts[emailKey] && !store.optouts[emailKey].notifiedAt) {
        store.optouts[emailKey].notifiedAt = new Date().toISOString();
        saveStore(file, store);
      }
    } catch (error) {
      logger.error(`Benachrichtigung für ${emailKey} fehlgeschlagen: ${error.message}`);
    } finally {
      inFlight.delete(emailKey);
    }
  }

  async function retryPending() {
    for (const [emailKey, record] of Object.entries(loadStore(file).optouts)) {
      if (!record.notifiedAt) await deliverPending(emailKey);
    }
  }

  function handler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      respond(res, 400, page('Ungültige Anfrage', '<p>Die Adresse ist ungültig.</p>'));
      return;
    }
    if (pathname === '/health' && req.method === 'GET') {
      try {
        loadStore(file);
        fs.accessSync(path.dirname(file), fs.constants.W_OK);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('ok');
      } catch {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('unavailable');
      }
      return;
    }
    const match = /^\/abmelden\/([A-Za-z0-9_.-]+)(\/fertig)?$/.exec(pathname);
    if (!match) {
      respond(res, 404, page('Nicht gefunden', '<p>Diese Seite gibt es nicht.</p>'));
      return;
    }

    let email;
    try {
      email = readToken(match[1], key);
    } catch {
      respond(res, 400, page('Ungültiger Link', '<p>Der Abmeldelink ist ungültig.</p>'));
      return;
    }

    if (match[2]) {
      if (req.method !== 'GET') {
        respond(res, 405, page('Methode nicht erlaubt', '<p>Diese Anfrage ist nicht erlaubt.</p>'), { Allow: 'GET' });
        return;
      }
      const done = !!loadStore(file).optouts[normalizedEmail(email)];
      respond(res, done ? 200 : 404, page(done ? 'Abmeldung gespeichert' : 'Nicht gefunden',
        done ? '<p>Ihre E-Mail-Adresse wurde in die Sperrliste aufgenommen.</p>' : '<p>Keine Abmeldung gefunden.</p>'));
      return;
    }

    if (req.method === 'GET') {
      const known = !!loadStore(file).optouts[normalizedEmail(email)];
      respond(res, 200, page('Kontakt abmelden', known
        ? '<p>Ihre E-Mail-Adresse ist bereits in der Sperrliste.</p>'
        : `<p>Für <strong>${escapeHtml(email)}</strong> keine weiteren Nachrichten erhalten?</p><form method="post"><button type="submit">Kontakt abmelden</button></form>`));
      return;
    }
    if (req.method !== 'POST') {
      respond(res, 405, page('Methode nicht erlaubt', '<p>Diese Anfrage ist nicht erlaubt.</p>'), { Allow: 'GET, POST' });
      return;
    }

    try {
      const emailKey = normalizedEmail(email);
      const store = loadStore(file);
      if (!store.optouts[emailKey]) {
        store.optouts[emailKey] = { email, requestedAt: new Date().toISOString(), notifiedAt: null };
        saveStore(file, store);
      }
      respond(res, 303, '', { Location: `${pathname}/fertig` });
      void deliverPending(emailKey);
    } catch (error) {
      logger.error(`Abmeldung konnte nicht gespeichert werden: ${error.message}`);
      respond(res, 500, page('Fehler', '<p>Die Abmeldung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.</p>'));
    }
  }

  return { handler, retryPending };
}

function publicBaseUrl(env = process.env) {
  const value = env.PUBLIC_BASE_URL || '';
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_BASE_URL fehlt oder ist ungültig.'); }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('PUBLIC_BASE_URL muss HTTPS verwenden.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_BASE_URL muss nur aus der Serveradresse bestehen.');
  }
  return url.origin;
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function main() {
  const [command, argument] = process.argv.slice(2);
  const file = dataFile();
  if (command === 'link') {
    if (!argument) throw new Error('Aufruf: node app.js link name@beispiel.de');
    console.log(`${publicBaseUrl()}/abmelden/${makeToken(argument, secretKey())}`);
  } else if (command === 'status') {
    if (!argument) throw new Error('Aufruf: node app.js status name@beispiel.de');
    console.log(loadStore(file).optouts[normalizedEmail(argument)] ? 'ABGEMELDET' : 'NICHT ABGEMELDET');
  } else if (command === 'export') {
    console.log('email,abgemeldet_am');
    for (const record of Object.values(loadStore(file).optouts)) {
      console.log(`${csvCell(record.email)},${csvCell(record.requestedAt)}`);
    }
  } else if (command === 'serve') {
    const key = secretKey();
    publicBaseUrl();
    for (const name of ['SMTP_USER', 'SMTP_APP_PASSWORD', 'NOTIFY_TO']) {
      if (!process.env[name]) throw new Error(`${name} fehlt.`);
    }
    emailAddress(process.env.SMTP_USER);
    emailAddress(process.env.NOTIFY_TO);
    const { handler, retryPending } = createApp({ key, file });
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT ist ungültig.');
    const host = process.env.HOST || '127.0.0.1';
    const server = http.createServer(handler);
    server.listen(port, host, () => console.log(`Abmeldeseite läuft auf ${host}:${port}`));
    void retryPending();
    setInterval(() => { void retryPending(); }, 5 * 60 * 1000).unref();
  } else {
    throw new Error('Aufruf: node app.js <link|status|export|serve> [E-Mail-Adresse]');
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp, dataFile, loadStore, makeToken, normalizedEmail, publicBaseUrl, readToken, secretKey };
