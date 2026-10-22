import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { fileURLToPath } from "node:url";
import { validateCommand, nextCommand, waitForStatus } from "./commands.js";

dotenv.config();

const app = express();
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

// Serve only public assets, never .env or server credentials.
for (const [route, file] of [["/", "index.html"], ["/app.js", "app.js"], ["/style.css", "style.css"],
  ["/pwa.js", "pwa.js"], ["/sw.js", "sw.js"], ["/manifest.webmanifest", "manifest.webmanifest"],
  ...[180, 192, 512].map((size) => [`/icons/icon-${size}.png`, `icons/icon-${size}.png`])]) {
  app.get(route, (_req, res) => {
    res.set("Cache-Control", "no-cache");
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
    ]
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function generateWithRetry(request, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (error) {
      if (error.status === 503 && attempt < retries) {
        console.log(`Gemini busy. Retry ${attempt}/${retries}...`);

        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });

        continue;
      }

      throw error;
    }
  }
}

app.post(
  "/api/voice-command",
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
        model: "gemini-3.5-flash-lite",

        contents: [
          {
            role: "user",

            parts: [
              {
                text: `
Listen to this voice command.

Extract the action, item and destination list ONLY when the user clearly says all three.
The user must explicitly say "add" or "remove" and explicitly name one of the supported lists.
Never infer an action or list from the item, context, or a typical usage pattern.
For example, if the user says only "Chico", return action null, item "Chico", list null.
Do not turn a bare item name into an add command.
Choose "shopping" when the user says shopping list or groceries.
Choose "todo" when the user says to-do list, task list, or something they need to do.
For example, "add milk to my shopping list" means action "add", item "milk", list "shopping".
"Add call the dentist to my to-do list" means action "add", item "call the dentist", list "todo".
Do not guess between the two lists. If the user names any other list, return that list name
as the "list" value exactly as heard; the command will be rejected and the user can try again.

Return ONLY valid JSON in this exact format:

{
  "action": "add", "remove", or null,
  "item": "<item name>",
  "list": "shopping", "todo", the unsupported list name, or null
}

Do not return markdown.
Do not return explanations.
`
              },

              {
                inlineData: {
                  mimeType,
                  data: audioBase64
                }
              }
            ]
          }
        ]
      });

      const cleanedText = (response.text ?? "")
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();

      let parsedCommand;
      try {
        parsedCommand = JSON.parse(cleanedText);
      } catch {
        return res.status(422).json({ error: "Could not understand a valid command. Please try again." });
      }
      let command;
      try {
        command = validateCommand(parsedCommand);
      } catch (error) {
        return res.status(422).json({ error: error.message });
      }
      res.json(command);
    } catch (error) {
      console.error("Voice command error:", {
        name: error.name,
        code: error.code,
        status: error.status,
        message: error.message
      });

      res.status(500).json({
        error: "Could not understand the voice command. Please try again."
      });
    }
  }
);

app.post("/api/confirm-command", async (req, res) => {
  let command;
  try {
    command = validateCommand(req.body);
  } catch (error) {
    return res.status(422).json({ error: error.message });
  }

  try {
    const result = await database.ref("command").transaction(
      (current) => nextCommand(current, command), undefined, false
    );
    if (!result.committed) throw new Error("Command was not saved.");
    res.json(result.snapshot.val());
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

app.get("/api/command-status/:count", async (req, res) => {
  const count = Number(req.params.count);
  if (!Number.isSafeInteger(count) || count < 1) {
    return res.status(400).json({ error: "Invalid command number." });
  }
  res.set("Cache-Control", "no-store");
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const status = await waitForStatus(database.ref("status"), count, { signal: controller.signal });
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
