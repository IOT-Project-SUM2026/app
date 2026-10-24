# Smart Display

Run `npm install`, configure `.env`, then run `npm start` and open http://127.0.0.1:3000.

Required environment variables: `GEMINI_API_KEY`, `FIREBASE_DATABASE_URL`, and
either `GOOGLE_APPLICATION_CREDENTIALS` (local: absolute path to the service
account JSON, stored outside this directory) or `FIREBASE_SERVICE_ACCOUNT`
(production: the JSON contents as a secret). Firebase can stay in locked mode:
only the backend uses the Admin SDK.

Hold the button to record, then release. The app asks Gemini to interpret the audio and shows
the action, item, and list for confirmation. Nothing is sent to Firebase until you choose
“Yes, send it”; “No, cancel” discards the command.
After confirmation, the validated result is written to
`/command` as `{ "type": "add", "item": "tomato", "list": "shopping", "runningCount": 1 }`.
Commands can target either list: for example, “add tomatoes to my shopping list” uses
`"list": "shopping"`, while “add call the dentist to my to-do list” uses `"list": "todo"`.
Other list names are rejected before anything is written to Firebase; the app asks the user
to choose the shopping list or to-do list.
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

This prototype has one shared command slot, matching the brief. Use one client
at a time; sending another command overwrites the previous slot. Before connecting
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

Before making a deployment public, protect `/api/*`. These endpoints currently
have no user authentication; anyone who can reach them can submit Gemini
requests and Firebase commands. The PWA conversion does not add account
management.

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