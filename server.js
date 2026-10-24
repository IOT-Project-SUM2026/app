import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getDatabase, ServerValue } from "firebase-admin/database";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import {
  validateCommand, nextCommand, waitForStatus, verifyTranscript, checkRemoval, applyListChange,
  checkHeard, checkDuplicate, UNCLEAR_MESSAGE, retryWhileBusy, BUSY_MESSAGE, withTimeout, commandStatusRef, isPushId,
  createRateLimiter, RATE_LIMIT_MESSAGE, COMMANDS_PER_MINUTE, STATUS_CHECKS_PER_MINUTE,
  isDeviceOffline, pendingCommands, listWithPending, DEVICE_OFFLINE_NOTE, storedItems, MISSING_VERB_MESSAGE
} from "./commands.js";

dotenv.config();

const app = express();
// Behind Railway's proxy, req.ip must be the visitor's address, not the proxy's.
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
app.use(express.json({ limit: "10kb" }));
for (const name of ["GEMINI_API_KEY", "FIREBASE_DATABASE_URL"]) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS");
}
const credential = process.env.FIREBASE_SERVICE_ACCOUNT
  ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  : applicationDefault();
initializeApp({ credential, databaseURL: process.env.FIREBASE_DATABASE_URL });
const database = getDatabase();
// Open the Firebase connection at startup so the first request is not slow.
database.ref("lists").get().catch(() => {});

// /lists/<name> is owned by the display (plain array) and is never written by this server.
// Our own tracking lives in /appLists/<name>; /lists/<name> as { items } is a legacy copy.
async function readList(name) {
  const [display, mine] = await Promise.all([
    database.ref(`lists/${name}`).get(), database.ref(`appLists/${name}`).get()
  ]);
  return { display: display.val(), mine: mine.val() };
}

// Is the display off or offline? It writes the time to /device/lastSeen every 10 seconds.
async function displayIsOffline() {
  try {
    return isDeviceOffline((await database.ref("device/lastSeen").get()).val());
  } catch {
    return false;
  }
}

// The display's own array wins when it keeps one; otherwise our tracked copy. While the display
// is offline, the commands still waiting in /commands are counted too, so that duplicate and
// removal checks match what the list will look like when the display is back.
async function currentList(name) {
  const { display, mine } = await readList(name);
  if (!Array.isArray(display) || !(await displayIsOffline())) {
    return Array.isArray(display) ? display : (mine ?? display);
  }
  const queue = (await database.ref("commands").limitToLast(200).get()).val();
  return listWithPending(display, mine, pendingCommands(queue, name));
}

// Keep our own copy of a list in sync after a command (idempotent). If the display keeps its
// own array in /lists, that array is the source of truth and nothing is written here.
async function syncTrackedList(sent) {
  const own = (await database.ref(`lists/${sent.list}`).get()).val();
  if (!Array.isArray(own)) {
    await database.ref(`appLists/${sent.list}`).transaction((stored) => applyListChange(stored ?? own, sent));
  }
}

async function removalError(command) {
  if (command.type !== "remove") return null;
  return checkRemoval(await currentList(command.list), command);
}

// "add milk" when milk is already there: nothing is written to the display.
async function duplicateMessage(command) {
  if (command.type !== "add") return null;
  return checkDuplicate(await currentList(command.list), command);
}
// Serve only public assets, never .env or server credentials.
for (const [route, file] of [["/", "index.html"], ["/app.js", "app.js"], ["/style.css", "style.css"],
  ["/pwa.js", "pwa.js"], ["/sw.js", "sw.js"], ["/manifest.webmanifest", "manifest.webmanifest"],
  ...[180, 192, 512].map((size) => [`/icons/icon-${size}.png`, `icons/icon-${size}.png`])]) {
  app.get(route, (_req, res) => {
    res.set("Cache-Control", route.startsWith("/icons/") ? "public, max-age=86400" : "no-cache");
    res.sendFile(fileURLToPath(new URL(file, import.meta.url)));
  });
}

const extraOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: [
      "https://iot-smart-display.netlify.app",
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "http://127.0.0.1:3000",
      "http://localhost:3000",
      ...extraOrigins
    ],
    allowedHeaders: ["Content-Type", "X-App-Code"]
  })
);

// Optional access code (APP_CODE in .env / Railway variables). When it is set, every /api
// request except /api/health must send it in the X-App-Code header, so a stranger who finds the
// server's address can't change the lists or use the Gemini key. The app asks for it once.
const APP_CODE = (process.env.APP_CODE || "").trim();
function codeMatches(sent) {
  const a = Buffer.from(String(sent ?? "")), b = Buffer.from(APP_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}
app.use("/api", (req, res, next) => {
  if (!APP_CODE || req.path === "/health" || codeMatches(req.get("X-App-Code"))) return next();
  res.status(401).json({ error: "Enter the app code to use this display.", needCode: true });
});

app.get("/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const VOICE_PROMPT = `
Listen to this voice command.

Extract the action, item and destination list ONLY when the user clearly says all three.
The user must explicitly say "add" or "remove" and explicitly name one of the supported lists.
Never infer an action or list from the item, context, or a typical usage pattern.
For example, if the user says only "Chico", return action null, item "Chico", list null.
Do not turn a bare item name into an add command.
The user may speak English or Hebrew. Keep "item" and "transcript" in the language and script the user
spoke; never translate them. Hebrew verbs such as תוסיף/הוסף mean "add" and תמחק/הסר mean "remove";
Hebrew קניות means the shopping list and משימות means the to-do list.
Choose "shopping" when the user says shopping list or groceries.
Choose "todo" when the user says to-do list, task list, or something they need to do.
For example, "add milk to my shopping list" means action "add", item "milk", list "shopping".
"Add call the dentist to my to-do list" means action "add", item "call the dentist", list "todo".
Do not guess between the two lists. If the user names any other list, return that list name
as the "list" value exactly as heard; the command will be rejected and the user can try again.

The item is whatever words come between the verb and the list name, even if it sounds strange, like a
question or a greeting: "add where are you to my shopping list" means action "add", item "where are you",
list "shopping". Decide by the sentence structure (verb, item, list), never by what the item means.
If the user negates the command ("don't add milk", "do not remove eggs", "אל תוסיף חלב"), return
action null; never do what the user said not to do.

Return "multipleItems": true when the user names more than one separate item, for example
"add milk and eggs" or "add milk, eggs and bread"; in that case "item" is the whole phrase.
Return false when the words form ONE item, for example "add mac and cheese" or "add salt and pepper
shaker". Decide by meaning, not by the word "and".

Also return "transcript": the exact words spoken, word for word, without adding anything.
If the audio is silent, only background noise, or contains no clear spoken words, return
"transcript": "" (an empty string). Never invent words that were not spoken.
If the audio is unclear or is not a command, return null for action, item and list.

Return ONLY valid JSON in this exact format:

{
  "transcript": "<exact words heard>",
  "action": "add", "remove", or null,
  "item": "<item name>",
  "multipleItems": true or false,
  "list": "shopping", "todo", the unsupported list name, or null
}

Do not return markdown.
Do not return explanations.
`;

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Gemini busy (503): retry 3 times, 2 seconds apart, then report an error.
function generateWithRetry(request) {
  // Every call is cancelled after 20 s, so the app never waits forever.
  return retryWhileBusy(() => withTimeout((abortSignal) => {
    // Test switch (ignored in production): SIMULATE_GEMINI=busy answers 503, =hang never answers.
    if (process.env.NODE_ENV !== "production" && process.env.SIMULATE_GEMINI === "busy") {
      return Promise.reject(Object.assign(new Error("Simulated busy Gemini"), { status: 503 }));
    }
    if (process.env.NODE_ENV !== "production" && process.env.SIMULATE_GEMINI === "hang") {
      return new Promise(() => {});
    }
    return ai.models.generateContent({ ...request, config: { ...request.config, abortSignal } });
  }), {
    onRetry: (attempt, retries) => console.log(`Gemini busy. Retry ${attempt}/${retries}...`)
  });
}

// At most 15 commands and 120 status checks per minute per address (separate counters), so a
// stuck phone or someone abusing the open API cannot drain the Gemini key or flood Firebase.
const limitBy = (limiter) => (req, res, next) => {
  const { allowed, retryAfterSeconds } = limiter.take(req.ip ?? "unknown");
  if (allowed) return next();
  console.log("Rate limited:", req.ip, req.path);
  res.set("Retry-After", String(retryAfterSeconds));
  res.status(429).json({ error: RATE_LIMIT_MESSAGE });
};
const voiceLimit = limitBy(createRateLimiter({ limit: COMMANDS_PER_MINUTE }));
const sendLimit = limitBy(createRateLimiter({ limit: COMMANDS_PER_MINUTE }));
const statusLimit = limitBy(createRateLimiter({ limit: STATUS_CHECKS_PER_MINUTE }));

app.post(
  "/api/voice-command",
  voiceLimit,
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "No audio file received"
        });
      }

      console.log("Audio received:");
      console.log("Size:", req.file.size);
      console.log("Type:", req.file.mimetype);

      const audioBase64 = req.file.buffer.toString("base64");
      const mimeType = /^audio\/mp4(?:;|$)/i.test(req.file.mimetype)
        ? "audio/m4a"
        : req.file.mimetype;

      const response = await generateWithRetry({
        model: GEMINI_MODEL,

        contents: [
          {
            role: "user",

            parts: [
              {
                text: `${VOICE_PROMPT}`
              },

              {
                inlineData: {
                  mimeType,
                  data: audioBase64
                }
              }
            ]
          }
        ],
        config: { temperature: 0, responseMimeType: "application/json" }
      });

      await answerUnderstood(res, response.text);
    } catch (error) {
      console.error("Voice command error:", {
        name: error.name,
        code: error.code,
        status: error.status,
        message: error.message
      });

      if (error.status === 503 || error.code === "GEMINI_TIMEOUT") {
        return res.status(503).json({ error: BUSY_MESSAGE });
      }
      res.status(500).json({
        error: "Could not understand the voice command. Please try again."
      });
    }
  }
);

// Same checks for a voice command and a typed one: Gemini's JSON must hold an explicit verb,
// one item that was really said (or typed) and a named list. `typed` replaces the transcript,
// so Gemini can't change what the user typed.
async function answerUnderstood(res, text, typed) {
  const cleanedText = (text ?? "").replace(/```json/g, "").replace(/```/g, "").trim();
  let parsedCommand;
  try {
    parsedCommand = JSON.parse(cleanedText);
  } catch {
    return res.status(422).json({ error: UNCLEAR_MESSAGE });
  }
  if (typed !== undefined && parsedCommand && typeof parsedCommand === "object") parsedCommand.transcript = typed;
  console.log(typed !== undefined ? "Gemini read:" : "Gemini heard:", JSON.stringify(parsedCommand));
  let command;
  try {
    parsedCommand = checkHeard(parsedCommand);
    // verifyTranscript returns the command with the list the user actually named.
    command = verifyTranscript(parsedCommand.transcript, validateCommand(parsedCommand));
  } catch (error) {
    console.log("Rejected:", error.message);
    return res.status(422).json({ error: error.message });
  }
  const missing = await removalError(command);
  if (missing) {
    console.log("Rejected:", missing);
    return res.status(422).json({ error: missing });
  }
  res.json(command);
}

// "Type instead": the typed sentence goes through the same prompt and the same checks as a
// recording, so typing follows exactly the same rules (and gives the same messages) as voice.
app.post("/api/text-command", voiceLimit, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim().replace(/\s+/g, " ") : "";
  if (!text) return res.status(422).json({ error: MISSING_VERB_MESSAGE });
  if (text.length > 200) return res.status(422).json({ error: "That's too long. Type one short command." });
  try {
    const response = await generateWithRetry({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts: [
        { text: VOICE_PROMPT },
        { text: `The user TYPED this command instead of speaking. Treat the typed text as the spoken words:\n${text}` }
      ] }],
      config: { temperature: 0, responseMimeType: "application/json" }
    });
    await answerUnderstood(res, response.text, text);
  } catch (error) {
    console.error("Typed command error:", { name: error.name, code: error.code, status: error.status });
    if (error.status === 503 || error.code === "GEMINI_TIMEOUT") return res.status(503).json({ error: BUSY_MESSAGE });
    res.status(500).json({ error: "Could not understand the command. Please try again." });
  }
});

// Both lists, shown under "Show my lists". While the display is offline the commands still
// waiting are included, so the phone shows what the display will show when it is back.
app.get("/api/lists", statusLimit, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const [shopping, todo] = await Promise.all([currentList("shopping"), currentList("todo")]);
    res.json({ shopping: storedItems(shopping), todo: storedItems(todo) });
  } catch {
    res.status(502).json({ error: "Couldn't load your lists right now." });
  }
});

// Is the display online? Shown above the button. The display writes /device/lastSeen (server
// time) every 10 s and /device/protocol; an older firmware can't read the /commands queue.
const PROTOCOL = 2;
app.get("/api/display", statusLimit, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const device = (await database.ref("device").get()).val() ?? {};
    const lastSeen = typeof device.lastSeen === "number" && device.lastSeen > 1e12 ? device.lastSeen : null;
    res.json({ online: lastSeen !== null && !isDeviceOffline(lastSeen), lastSeen,
      needsUpdate: lastSeen !== null && device.protocol !== PROTOCOL });
  } catch {
    res.status(502).json({ error: "Couldn't check the display right now." });
  }
});

app.post("/api/confirm-command", sendLimit, async (req, res) => {
  let command;
  try {
    command = validateCommand(req.body);
  } catch (error) {
    return res.status(422).json({ error: error.message });
  }

  try {
    const missing = await removalError(command);
    if (missing) return res.status(422).json({ error: missing });
    const duplicate = await duplicateMessage(command);
    if (duplicate) {
      console.log("Already on the list:", duplicate);
      return res.json({ ...command, duplicate: true, message: duplicate });
    }
    const result = await database.ref("command").transaction(
      (current) => nextCommand(current, command), undefined, false
    );
    if (!result.committed) throw new Error("Command was not saved.");
    const numbered = result.snapshot.val();
    // The command also gets its own place in the /commands queue (a Firebase push id), so two
    // phones sending at the same moment never overwrite each other. /command above is kept as
    // the "latest command" slot for displays that only read that.
    const entry = database.ref("commands").push();
    await entry.set({ ...numbered, createdAt: ServerValue.TIMESTAMP });
    res.json({ ...numbered, id: entry.key });
  } catch (error) {
    console.error("Confirmed command error:", {
      name: error.name,
      code: error.code,
      message: error.message
    });
    res.status(500).json({
      error: "Could not send the command. Check your list before trying again."
    });
  }
});

// Replies nobody read: when the display was offline the server answered at once, and the
// display still writes its reply when it is back. Replies older than 10 minutes are removed
// (checked at most once a minute).
let lastCleanUp = 0;
function cleanUpOldReplies() {
  if (Date.now() - lastCleanUp < 60000) return;
  lastCleanUp = Date.now();
  database.ref("status").orderByChild("at").endAt(Date.now() - 600000).get()
    .then((old) => {
      const removals = {};
      old.forEach((child) => { removals[child.key] = null; });
      if (Object.keys(removals).length) return database.ref("status").update(removals);
    })
    .catch(() => {});
}

// The reply for a command whose display is offline: success, without making the user wait.
// Returns null when the command is unknown or the display already answered it.
async function answerForOfflineDisplay(id, count) {
  const sent = (await database.ref(`commands/${id}`).get()).val();
  if (!sent || sent.runningCount !== count || sent.status) return null;
  if (["add", "remove"].includes(sent.type) && ["shopping", "todo"].includes(sent.list)) {
    try {
      await syncTrackedList(sent);
    } catch (error) {
      console.error("List sync error:", error.code ?? error.name);
    }
  }
  return { runningCount: count, success: true, text: DEVICE_OFFLINE_NOTE, queued: true };
}

app.get("/api/command-status/:count", statusLimit, async (req, res) => {
  const count = Number(req.params.count);
  if (!Number.isSafeInteger(count) || count < 1) {
    return res.status(400).json({ error: "Invalid command number." });
  }
  const id = req.query.id;
  if (id !== undefined && !isPushId(id)) {
    return res.status(400).json({ error: "Invalid command id." });
  }
  res.set("Cache-Control", "no-store");
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    // This phone only listens for the reply to ITS command: the private reply in its queue
    // entry, or (older displays) the shared /status carrying the same runningCount.
    // Display off or offline: answer at once, as if it had answered. The command stays in the
    // /commands queue and the display applies it when it is back.
    if (id && await displayIsOffline()) {
      const queued = await answerForOfflineDisplay(id, count);
      if (queued) {
        console.log("Display offline: command", count, "queued");
        return res.json({ status: queued });
      }
    }
    // The current display firmware answers in /status/<id> (and removes /commands/<id>).
    // Only this command's own reply is watched, not the whole /status folder, so a reply to
    // another command doesn't wake this request. The shared /status slot is only for an old
    // client that sends no id.
    const sources = id
      ? [commandStatusRef(database.ref(`status/${id}`), count), commandStatusRef(database.ref(`commands/${id}/status`), count)]
      : [database.ref("status")];
    let status = await waitForStatus(sources, count, { signal: controller.signal });
    if (id) database.ref(`status/${id}`).remove().catch(() => {});  // read once
    cleanUpOldReplies();
    // No answer in time and the display went offline meanwhile: same quiet answer.
    if (!status && id && await displayIsOffline()) status = await answerForOfflineDisplay(id, count);
    if (status?.success && !status.queued) {
      // Keep our copy of the lists in sync once the display confirmed (idempotent).
      try {
        const sent = (await database.ref(id ? `commands/${id}` : "command").get()).val();
        if (sent?.runningCount === count && ["add", "remove"].includes(sent.type) &&
            ["shopping", "todo"].includes(sent.list)) {
          await syncTrackedList(sent);
        }
      } catch (error) {
        console.error("List sync error:", error.code ?? error.name);
      }
    }
    if (!res.destroyed) res.json({ status });
  } catch {
    if (!res.destroyed) res.status(502).json({ error: "Unable to read display confirmation." });
  }
});

app.use((error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON request." });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "JSON request is too large." });
  }
  res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Audio upload failed. Try a shorter recording." });
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on ${HOST}:${PORT}`);
});
