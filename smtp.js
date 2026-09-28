'use strict';

const tls = require('node:tls');

function smtpConnection(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, minVersion: 'TLSv1.2' });
    socket.setTimeout(20_000);
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('SMTP-Zeitüberschreitung')));
  });
}

function smtpReader(socket) {
  let buffer = '';
  const lines = [];
  let waiting = null;
  let failed = null;

  function fail(error) {
    failed = error;
    if (waiting) { waiting.reject(error); waiting = null; }
  }
  function emit() {
    if (waiting && lines.length) {
      const current = waiting;
      waiting = null;
      current.resolve(lines.shift());
    }
  }
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\r\n')) !== -1) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
    emit();
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('SMTP-Verbindung geschlossen')));

  async function line() {
    if (failed) throw failed;
    if (lines.length) return lines.shift();
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  }

  async function response(expected) {
    let first;
    let current;
    do {
      current = await line();
      if (!/^\d{3}[ -]/.test(current)) throw new Error('Ungültige SMTP-Antwort');
      if (!first) first = current.slice(0, 3);
      if (current.slice(0, 3) !== first) throw new Error('Ungültige SMTP-Antwort');
    } while (current[3] === '-');
    if (first !== String(expected)) throw new Error(`SMTP-Antwort ${first} statt ${expected}`);
  }

  async function command(text, expected) {
    socket.write(`${text}\r\n`);
    await response(expected);
  }
  return { response, command };
}

async function sendNotification(email, requestedAt, env = process.env) {
  const host = env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(env.SMTP_PORT || 465);
  const user = env.SMTP_USER;
  const password = env.SMTP_APP_PASSWORD;
  const to = env.NOTIFY_TO;
  if (!user || !password || !to || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP-Konfiguration ist unvollständig.');
  }

  const socket = await smtpConnection(host, port);
  try {
    const smtp = smtpReader(socket);
    await smtp.response(220);
    await smtp.command('EHLO localhost', 250);
    await smtp.command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`, 235);
    await smtp.command(`MAIL FROM:<${user}>`, 250);
    await smtp.command(`RCPT TO:<${to}>`, 250);
    await smtp.command('DATA', 354);
    const body = [
      `From: <${user}>`,
      `To: <${to}>`,
      'Subject: Kontaktabmeldung',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Diese Adresse moechte nicht mehr kontaktiert werden:',
      email,
      '',
      `Abmeldung (UTC): ${requestedAt}`,
      '',
    ].join('\r\n');
    socket.write(`${body.replace(/^\./gm, '..')}\r\n.\r\n`);
    await smtp.response(250);
    await smtp.command('QUIT', 221);
  } finally {
    socket.destroy();
  }
}

module.exports = { sendNotification };
