# Kontaktabmeldung mit Coolify

Für jede angeschriebene Person wird ein eigener Link erzeugt. Er enthält ihre E-Mail-Adresse verschlüsselt. Nach der Bestätigung auf der Webseite wird die Adresse in einer dauerhaften Sperrliste gespeichert und eine Benachrichtigung an dein Gmail-Postfach gesendet. Wenn Gmail vorübergehend nicht erreichbar ist, versucht die Anwendung die Benachrichtigung alle fünf Minuten erneut.

Die Bestätigung auf der Webseite ist nötig, weil Mailprogramme und Sicherheitsfilter Links automatisch öffnen können. Ein Seitenaufruf allein löst deshalb keine Abmeldung aus.

## Coolify einrichten

1. Dieses Git-Repository in Coolify als neue **Application** aus einem Git-Repository hinzufügen. Für ein privates Repository muss Coolify Zugriff über eine GitHub App oder einen Deploy Key haben.
2. Als **Build Pack: Docker Compose** wählen. **Branch: `main`**, **Base Directory: `/`**, **Docker Compose Location: `compose.yaml`** setzen.
3. In den Umgebungsvariablen diese fünf Werte als **Runtime-Variablen** eintragen:

   | Name | Wert |
   | --- | --- |
   | `PUBLIC_BASE_URL` | Öffentliche HTTPS-Adresse, zum Beispiel `https://abmelden.example.de` (ohne Port und ohne abschließenden Schrägstrich) |
   | `TOKEN_SECRET` | Einmalig erzeugter, dauerhaft gleicher Schlüssel mit 64 Hex-Zeichen |
   | `SMTP_USER` | Gmail-Adresse des sendenden Kontos |
   | `SMTP_APP_PASSWORD` | App-Passwort dieses Google-Kontos, ohne Leerzeichen |
   | `NOTIFY_TO` | Gmail-Adresse, an die die Abmeldungen gehen sollen |

   Schlüssel erzeugen, zum Beispiel lokal mit:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Für ein [Google-App-Passwort](https://support.google.com/accounts/answer/185833?hl=de) muss die Bestätigung in zwei Schritten aktiviert sein; bei manchen Konten ist diese Funktion nicht verfügbar. Das normale Google-Passwort nicht eintragen.

4. In der Compose-Anwendung beim Dienst `abmeldung` unter **Domains** die Adresse mit internem Port eintragen, zum Beispiel **`https://abmelden.example.de:3000`**. Nach außen bleibt die URL `https://abmelden.example.de`; `:3000` zeigt Coolify nur den internen Container-Port an. Den DNS-Eintrag der Domain auf den Coolify-Server richten.
5. **Deploy** ausführen. Die Compose-Datei legt automatisch ein persistentes Volume für `/app/data` an. Im Coolify-Status und unter `/health` prüfen, ob der Dienst läuft. Für das Volume eine Sicherung einrichten.

Nur **eine Instanz** des Dienstes betreiben. Die Datei-Sperrliste unterstützt keine parallelen Schreibzugriffe mehrerer Instanzen.

## Persönliche Links erzeugen

In Coolify im **Terminal** des laufenden `abmeldung`-Containers:

```sh
node app.js link empfaenger@example.org
```

Die ausgegebene URL hinter den Text **„Falls ich Sie nicht mehr kontaktieren soll, klicken Sie hier“** setzen. Für jede Person ihre eigene Adresse einsetzen. Ein für alle identischer Link kann die E-Mail-Adresse nicht zuverlässig aus dem Mailprogramm auslesen.

Alternativ lokal mit Node.js 22 und einer eigenen, nicht ins Git-Repository aufgenommenen `.env`-Datei arbeiten: `node --env-file=.env app.js link empfaenger@example.org`. Die Werte `PUBLIC_BASE_URL` und `TOKEN_SECRET` müssen mit Coolify identisch sein.

## Sperrliste prüfen

Im Coolify-Terminal:

```sh
node app.js status empfaenger@example.org
node app.js export
```

`export` gibt eine CSV-Liste aus. Sie muss vor weiteren Aussendungen berücksichtigt werden. Eine Gmail-Benachrichtigung allein stoppt keine externe Versandsoftware automatisch. Das Volume und den `TOKEN_SECRET` sicher aufbewahren und sichern. Wird der Schlüssel geändert, funktionieren bereits verschickte Links nicht mehr.

## Lokal testen

```sh
node --test
```
