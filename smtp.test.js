'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const tls = require('node:tls');
const { sendNotification } = require('./smtp');

test('SMTP sendet eine Benachrichtigung per TLS an das konfigurierte Postfach', async t => {
  const originalConnect = tls.connect;
  const commands = [];
  class FakeSocket extends EventEmitter {
    setTimeout() {}
    write(data) {
      commands.push(data);
      let answer;
      if (data.startsWith('EHLO ')) answer = '250-localhost\r\n250 AUTH PLAIN\r\n';
      else if (data.startsWith('AUTH PLAIN ')) answer = '235 Angemeldet\r\n';
      else if (data.startsWith('MAIL FROM:')) answer = '250 OK\r\n';
      else if (data.startsWith('RCPT TO:')) answer = '250 OK\r\n';
      else if (data.startsWith('DATA')) answer = '354 Text senden\r\n';
      else if (data.endsWith('\r\n.\r\n')) answer = '250 Angenommen\r\n';
      else if (data.startsWith('QUIT')) answer = '221 Auf Wiedersehen\r\n';
      else throw new Error(`Unerwartetes SMTP-Kommando: ${data}`);
      setImmediate(() => this.emit('data', Buffer.from(answer)));
      return true;
    }
    destroy() { this.emit('close'); }
  }
  tls.connect = () => {
    const socket = new FakeSocket();
    setImmediate(() => {
      socket.emit('secureConnect');
      setImmediate(() => socket.emit('data', Buffer.from('220 Bereit\r\n')));
    });
    return socket;
  };
  t.after(() => { tls.connect = originalConnect; });

  await sendNotification('person@example.org', '2026-09-28T12:00:00.000Z', {
    SMTP_USER: 'sender@gmail.com',
    SMTP_APP_PASSWORD: 'app-password',
    NOTIFY_TO: 'owner@gmail.com',
  });

  assert.match(commands[1], /^AUTH PLAIN /);
  assert.equal(commands[3], 'RCPT TO:<owner@gmail.com>\r\n');
  assert.match(commands[5], /person@example\.org/);
  assert.match(commands[5], /Abmeldung \(UTC\): 2026-09-28T12:00:00\.000Z/);
});
