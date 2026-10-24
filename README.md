# Smart Display

Run `npm install`, configure `.env`, then run `npm start` and open http://127.0.0.1:3000.

Required environment variables: `GEMINI_API_KEY`, `FIREBASE_DATABASE_URL`, and
either `GOOGLE_APPLICATION_CREDENTIALS` (local: absolute path to the service
account JSON, stored outside this directory) or `FIREBASE_SERVICE_ACCOUNT`
(production: the JSON contents as a secret). Firebase can stay in locked mode:
only the backend uses the Admin SDK.

Hold the button to record, then release. The app asks Gemini to interpret the audio and shows
the action, item, and list. There is no confirmation step: once the command is understood and
validated, it is sent immediately. The validated result is written to
`/command` as `{ "type": "add", "item": "tomato", "list": "shopping", "runningCount": 1 }`.
Commands can target either list: for example, “add tomatoes to my shopping list” uses
`"list": "shopping"`, while “add call the dentist to my to-do list” uses `"list": "todo"`.
Other list names are rejected before anything is written to Firebase; the app asks the user
to choose the shopping list or to-do list ("There are two lists: shopping and to-do.").
The model is instructed not to infer an action or list from an item name alone; incomplete
commands are rejected with a prompt to say the action and list.
The counter increments atomically for every write, including repeated commands.

The app waits up to 60 seconds for `/status` containing the same numeric
`runningCount`, a boolean `success`, and a message in `text`. Old confirmations
are ignored. This correlation field is an extension to the original brief and
must also be written by the final ESP32 firmware.

## Test without the ESP32

Speak a command and check `/command` in the Firebase console. While the app is
waiting, add or edit `/status` to contain:

```json
{
  "runningCount": 1,
  "success": true,
  "text": "Simulated confirmation: tomato added"
}
```

Use the actual number from `/command`, and save within the 60-second waiting
window. This simulates an acknowledgement; it does not update a physical device.
The app should show `Confirmed`. Setting `success` to false tests a device error.
Without a response it reports a timeout, leaving the command in Firebase.

**Command queue (several phones at once).** Every confirmed command is also stored in
its own place in `/commands/<pushId>` (a Firebase push id) as
`{ "type": "add", "item": "milk", "list": "shopping", "runningCount": 7, "createdAt": … }`,
so two phones sending at the same moment never overwrite each other. The display should
read `/commands` and answer each command by writing `{ "success": true, "text": "…" }` to
`/commands/<pushId>/status`; each phone only waits for the reply to its own command.
`/command` still holds the latest command and `/status` is still understood
(matched by `runningCount`) for a display that only supports the original slots, but
such a display can overwrite replies when two phones send at once.

**Display off or offline.** The display writes the current time (Firebase server timestamp,
epoch milliseconds, for example `{".sv": "timestamp"}`) to `/device/lastSeen` every 10 seconds.
If that value is more than 25 seconds old, the server answers the app at once, like an
online display ("Added milk to your shopping list"), checking duplicates and removals against
`/lists` plus the commands still waiting in `/commands`. The command stays in the
`/commands` queue; when the display is back it must apply every entry that has no `status`
yet, in `runningCount` order, and write `{ "success": true, "text": "…" }` to
`/commands/<pushId>/status`. A display that never writes `/device/lastSeen` (or writes a
value that is not a clock time) is assumed to be online, so the old behaviour is kept.
The display-side code (`firebase_sync.h`) belongs to the ESP32 firmware, not to this app.

**Undo.** After a command that really changed a list, the app shows an Undo button. It
sends the opposite command (add ↔ remove) without a recording, through the same checks and
queue as a voice command. It is not offered when the list did not change (already on the
list, display error, no reply) and cannot be undone again.

Before connecting
the team's device, agree on its exact fields and access rules. Change the database
URL and credentials in `.env` and restart when moving to the team's project.

Run `npm test` for local protocol tests. `node check-firebase.js` tests real Firebase
access using a temporary `_integrationChecks` child, then removes that child.
It does not write to the real `/command` or `/status` paths.

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