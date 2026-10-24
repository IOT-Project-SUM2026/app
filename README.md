# Smart Display

Phone app and server of the **Smart Display** project (Technion IoT course 236333).
The ESP32 display firmware is in the other repository:
https://github.com/IOT-Project-SUM2026/dispaly

Run `npm install`, configure `.env`, then run `npm start` and open http://127.0.0.1:3000.

Required environment variables: `GEMINI_API_KEY`, `FIREBASE_DATABASE_URL`, and
either `GOOGLE_APPLICATION_CREDENTIALS` (local: absolute path to the service
account JSON, stored outside this directory) or `FIREBASE_SERVICE_ACCOUNT`
(production: the JSON contents as a secret). Firebase can stay in locked mode:
only the backend uses the Admin SDK.

Hold the button to record, then release (or tap **Type instead** and type the command). The
server sends the recording, or the typed text, to Gemini with the same prompt, then checks the
answer: there must be an explicit "add" or "remove", one item that was really said, and a named
list ("shopping" or "to-do"). Anything else is rejected with a message that says what to say
instead, and nothing is written to Firebase. There is no confirmation step: a valid command is
sent at once. "Add" for an item already on the list, and "remove" for an item that isn't, are
answered without sending anything to the display.

## How the app and the display talk (Firebase Realtime Database)

| Path | Written by | Content |
|---|---|---|
| `/commands/<pushId>` | server | `{type, item, list, createdAt, runningCount}`: one entry per command (a Firebase push id, so two phones never overwrite each other) |
| `/status/<pushId>` | display | `{success, changed, text, at}`: the display's reply, e.g. "Added milk to your shopping list"; the display removes `/commands/<pushId>` in the same request |
| `/device` | display | `lastSeen` (server time, every 10 s) and `protocol` (2) |
| `/lists` | display | `{shopping: [...], todo: [...]}`: the lists after every change |

The server waits up to 60 s for `/status/<pushId>`, returns it to the app and deletes it.
Replies nobody read are removed after 10 minutes.

**Display off or offline.** If `/device/lastSeen` is more than 25 seconds old, the server answers
the app at once, like an online display, checking duplicates and removals against `/lists` plus
the commands still waiting in `/commands`. The command stays in the queue and the display applies
it when it is back. The app shows "Display offline since 17:05" above the button.

**Undo.** After a command that changed a list, the app offers "Undo (remove milk)". It sends the
opposite command without a recording, through the same checks and queue.

`/command` (a single "latest command" slot with `runningCount`) is still written for older
displays; the current firmware doesn't use it.

## Test without the ESP32

Send a command, then in the Firebase console add `/status/<pushId>` (the id of the new entry
under `/commands`) = `{"success": true, "text": "Simulated: milk added"}` within 60 seconds:
the app shows that text. `"success": false` tests a display error. If `/device/lastSeen` is
older than 25 seconds, the server answers at once as for an offline display.

Run `npm test` for local protocol tests. `node check-firebase.js` tests real Firebase
access using a temporary `_integrationChecks` child, then removes that child.
It does not write to the real `/commands`, `/status` or `/lists` paths.

## Deploy (single Railway service: app + server together)

Do not use your Mac path for `GOOGLE_APPLICATION_CREDENTIALS` in production.
Never commit `.env` or the Firebase JSON file.

`server.js` serves the web app (HTML/JS/CSS/PWA files) and the `/api/*` endpoints from
the same address, so one deployment is the whole system and no CORS setup is needed.

**Railway:** set the root to this folder, start with `npm start`, and add:

- `NODE_ENV=production`
- `GEMINI_API_KEY`
- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT` — paste the **full JSON** from the Desktop service-account file (not the file path)

Do not set `GOOGLE_APPLICATION_CREDENTIALS` on Railway. After deploy, open the public
URL (`https://….up.railway.app`) on your phone; that is the app.

- `APP_CODE` (recommended) — any secret word. When it is set, every `/api/*` request except
  `/api/health` must send it in the `X-App-Code` header. The app asks for it once and keeps
  it on the phone, so a stranger who finds the address can't change the lists or use the
  Gemini key. Without `APP_CODE` the API is open (still limited per address per minute).
- `GEMINI_MODEL` (optional) — defaults to `gemini-3.5-flash-lite`.

### Endpoints

- `POST /api/voice-command` — recording → understood command (or 422 with the reason).
- `POST /api/text-command` `{text}` — "Type instead": the typed sentence goes through the
  same prompt and the same checks as a recording, so it follows the same rules and messages.
- `POST /api/confirm-command` — sends a command to the display (`/commands` queue).
- `GET /api/command-status/:count?id=` — the display's reply. The current firmware writes
  it to `/status/<id>`; it is removed once read.
- `GET /api/lists` — both lists for "Show my lists" (with commands still waiting while the
  display is offline).
- `GET /api/display` — `{online, lastSeen, needsUpdate}` for the line above the button
  ("Display online" / "Display offline since 17:05" / "The display needs a firmware update").

After deployment, open the HTTPS URL on your phone:

- iPhone/iPad: Safari → Share → Add to Home Screen → Add. If offered, enable
  “Open as Web App”. The app also provides an install-help button on iOS.
- Android: Chrome → Install app (the in-app button appears when Chrome offers
  installation), or use Chrome's menu → Add to Home screen / Install app.

Open the installed app and allow microphone access. The interface is cached after
its first successful online visit and can open offline, but recording commands
requires internet access to Gemini, Firebase, and the backend. Audio and API
responses are never cached or queued; reconnecting does not replay commands.

The service worker uses network-first retrieval for public assets. Updates activate
once older app windows close; reopen the installed app to pick up an updated worker.
Increment the cache version in `sw.js` when changing the app shell's offline assets.