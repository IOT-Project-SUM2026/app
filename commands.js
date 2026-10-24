export const MISSING_VERB_MESSAGE =
  "Say “add” or “remove”, then one item, e.g. “Add milk to my shopping list”.";

export const ONE_ITEM_MESSAGE = "One item at a time, please.";
// Separators that can only mean a list of items. "and" is decided by the model
// (multipleItems), because "mac and cheese" is a single item.
const ITEM_SEPARATORS = /[,;،、؛]/;

export const LIST_MESSAGE = "There are two lists: shopping and to-do.";

export const NO_LIST_MESSAGE =
  "Say which list: “to my shopping list” or “to my to-do list”.";

// Polishes what the model returned as the item: surrounding punctuation is ignored and
// leading fillers are dropped ("the Milk." -> "Milk"). Capitals are kept as spoken.
const LEADING_FILLERS = new Set([
  "please", "a", "an", "the", "some", "my", "your", "our",
  "le", "la", "les", "l", "un", "une", "du", "des", "de", "mon", "ma", "את"
]);
export function cleanItem(item) {
  if (typeof item !== "string") return "";
  const words = item.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").split(/\s+/).filter(Boolean);
  // Keep a lone filler so "add the" is reported as having no item.
  while (words.length > 1 && LEADING_FILLERS.has(strip(words[0]))) words.shift();
  return words.join(" ");
}

export const ITEM_MESSAGE = "I couldn't make out the item.";
export const TOO_LONG_MESSAGE = "That item is too long.";
const MAX_ITEM_CHARS = 40;
const MAX_ITEM_BYTES = 47;
// Words that cannot be an item on their own ("add the").
const FILLER_WORDS = new Set([
  "the", "a", "an", "my", "your", "our", "some", "to", "of", "for", "in", "on", "and", "please",
  "this", "that", "it", "list", "le", "la", "les", "l", "un", "une", "du", "de", "des", "mon", "ma",
  "את", "של", "ה", "ו", "ל"
]);

export const NEGATION_MESSAGE = "Nothing was changed.";

export const BUSY_MESSAGE = "The voice service is busy right now. Please try again in a moment.";
export const GEMINI_TIMEOUT_MS = 20000;

// Runs `task(signal)` but gives up after `ms` (default 20 s): the call is cancelled through
// the signal and the result is a GEMINI_TIMEOUT error, so the app never waits forever.
export async function withTimeout(task, ms = GEMINI_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("The voice service did not answer in time."), { code: "GEMINI_TIMEOUT" }));
    }, ms);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs `task`; while Gemini answers 503 (busy) it waits and retries, then gives up
// and rethrows the 503 so the caller can report an error.
export async function retryWhileBusy(task, { retries = 3, delayMs = 2000, sleep, onRetry } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (error?.status !== 503 || attempt > retries) throw error;
      onRetry?.(attempt, retries);
      await wait(delayMs);
    }
  }
}

export const RATE_LIMIT_MESSAGE = "Too many requests. Wait a minute and try again.";
export const COMMANDS_PER_MINUTE = 15;
export const STATUS_CHECKS_PER_MINUTE = 120;

// Counts requests per address in a fixed time window. Protects the Gemini key and the
// database from a stuck phone or from someone abusing the open API.
export function createRateLimiter({ limit, windowMs = 60000, now = Date.now, maxKeys = 5000 }) {
  const windows = new Map();
  return {
    take(key) {
      const time = now();
      let entry = windows.get(key);
      if (!entry || time >= entry.resetAt) {
        entry = { count: 0, resetAt: time + windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      if (windows.size > maxKeys) {
        for (const [other, value] of windows) if (time >= value.resetAt) windows.delete(other);
      }
      return { allowed: entry.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - time) / 1000)) };
    }
  };
}

export const SILENCE_MESSAGE = "I didn't hear anything. Hold the button while you speak.";
export const UNCLEAR_MESSAGE = "Could not understand a valid command. Please try again.";

// Runs before validation: silence, noise or a cut-off recording produce no words.
export function checkHeard(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(UNCLEAR_MESSAGE);
  }
  if (typeof parsed.transcript !== "string" || !strip(parsed.transcript)) {
    throw new Error(SILENCE_MESSAGE);
  }
  // Even if the model returned action null for "don't add milk", say nothing was changed.
  const heard = strip(parsed.transcript);
  if (isNegatedCommand(heard, parsed.item)) throw new Error(NEGATION_MESSAGE);
  let result = parsed;
  // The user clearly said "add" or "remove" (not both) but the model returned no action
  // (for example "Add the"): use the spoken verb, so the real problem is reported.
  const said = ["add", "remove"].filter((type) => hasAction(type, heard));
  if (!["add", "remove"].includes(parsed.action ?? parsed.type) && said.length === 1) {
    result = { ...result, action: said[0] };
  }
  // A list the user named always wins over the model's choice (or its null).
  const list = namedList(heard, parsed.item);
  return list === "shopping" || list === "todo" ? { ...result, list } : result;
}

export function validateCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(UNCLEAR_MESSAGE);
  }
  const type = value.action ?? value.type;
  if (!["add", "remove"].includes(type)) {
    throw new Error(MISSING_VERB_MESSAGE);
  }
  const spokenItem = cleanItem(value.item);
  // The display keeps up to 47 bytes per item (Hebrew letters take 2 bytes each).
  if ([...spokenItem].length > MAX_ITEM_CHARS || new TextEncoder().encode(spokenItem).length > MAX_ITEM_BYTES) {
    throw new Error(TOO_LONG_MESSAGE);
  }
  // Empty, or only filler words such as "the" / "a" / "my": there is no item.
  if (!strip(spokenItem).split(" ").some((word) => word && !FILLER_WORDS.has(word))) {
    throw new Error(ITEM_MESSAGE);
  }
  if (value.multipleItems === true || ITEM_SEPARATORS.test(spokenItem)) {
    throw new Error(ONE_ITEM_MESSAGE);
  }
  if (!["shopping", "todo"].includes(value.list)) {
    // No list at all -> ask which one; some other list name -> only two exist.
    throw new Error(typeof value.list === "string" && value.list.trim() ? LIST_MESSAGE : NO_LIST_MESSAGE);
  }
  return { type, item: spokenItem, list: value.list };
}

const strip = (text) => String(text ?? "").toLowerCase().normalize("NFD")
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

// /lists/<name> may be a plain array maintained by the display, or our own { items } object.
export function storedItems(stored) {
  if (Array.isArray(stored)) return stored;
  return Array.isArray(stored?.items) ? stored.items : [];
}

export function normalizeItem(item) {
  return strip(item);
}

const ACTION_WORDS = {
  add: /\b(add|put|ajoute\w*|rajoute\w*|mets?|met)\b/,
  remove: /\b(remove|delete|take off|take out|clear|retire\w*|enleve\w*|supprime\w*|efface\w*)\b/
};
const LIST_WORDS = {
  shopping: /\b(shopping|groceries|grocery|courses)\b/,
  todo: /\b(to ?do|task|tasks|tache|taches|a faire)\b/
};

// Hebrew: \b only understands ASCII, so match whole words with Unicode lookarounds.
// One optional attached prefix letter is allowed (ו and, ל to, ה the, ב in, ש that).
const hebrew = (words) => new RegExp(`(?<!\\p{L})[ולהבש]?(?:${words})(?!\\p{L})`, "u");
const HEBREW_ACTION = {
  add: hebrew("הוסף|הוסיפי|תוסיף|תוסיפי|להוסיף|תכניס|תכניסי|הכנס|הכניסי|שים|שימי|תשים|תשימי"),
  remove: hebrew("הסר|הסירי|תסיר|תסירי|להסיר|מחק|מחקי|תמחק|תמחקי|למחוק|הוצא|הוציאי|תוציא|תוציאי|הורד|הורידי|תוריד|תורידי")
};
const HEBREW_LIST = {
  shopping: hebrew("קניות|סופר|מצרכים"),
  todo: hebrew("משימות|משימה|מטלות|מטלה|לעשות")
};
// Negation: the command must not be turned into the very action the user refused.
// (strip() turns "don't" into "don t".) Hebrew: אל (do not) and לא (not).
const NEGATION = /\b(don t|dont|do not|doesn t|never|not|no|won t|without|stop|cancel|forget|nevermind|pas|jamais)\b/;
const HEBREW_NEGATION = hebrew("אל|לא");
const isNegated = (heard) => NEGATION.test(heard) || HEBREW_NEGATION.test(heard);
// A spoken list reference: "list"/"liste" (English, French) or רשימה/רשימת (Hebrew).
const MENTIONS_A_LIST = new RegExp(`\\b(list|lists|liste|listes)\\b|${hebrew("רשימה|רשימת|רשימות").source}`, "u");
const hasAction = (type, heard) => ACTION_WORDS[type].test(heard) || HEBREW_ACTION[type].test(heard);
const hasList = (list, heard) => LIST_WORDS[list].test(heard) || HEBREW_LIST[list].test(heard);

// A whole word of the item must be a whole spoken word ("milk" is not in "buttermilk").
// Hebrew attaches small prefixes to words (ה the, ל to, ו and, ב in, ש that, כ as, מ from),
// so "חלב" counts as said when the user said "החלב".
const HEBREW_PREFIXES = /^[והלבשכמ]{1,2}$/u;
const wasSaid = (word, heardWords) => heardWords.some((spoken) =>
  spoken === word || (/\p{Script=Hebrew}/u.test(word) && spoken.endsWith(word) &&
    HEBREW_PREFIXES.test(spoken.slice(0, spoken.length - word.length))));

// Which list did the user actually name? "shopping", "todo", "both" or "none".
// The item is cut out first, so "shopping bag" is not mistaken for the shopping list.
function namedList(heard, item) {
  const phrase = strip(item);
  const rest = phrase ? heard.replace(phrase, " ") : heard;
  const shopping = hasList("shopping", rest);
  const todo = hasList("todo", rest);
  if (shopping && todo) return "both";
  return shopping ? "shopping" : todo ? "todo" : "none";
}

// "don't add milk" / "אל תוסיף חלב": an add/remove verb that the user negated.
// Words inside the item itself (for example "no salt crackers") do not count.
export function isNegatedCommand(heard, item) {
  const phrase = strip(item);
  const rest = phrase ? heard.replace(phrase, " ") : heard;
  return (hasAction("add", heard) || hasAction("remove", heard)) && isNegated(rest);
}

// The model must prove what it heard: the transcript has to contain an explicit
// action word, an explicit list name and the item. Prevents "bro" -> add.
export function verifyTranscript(transcript, command) {
  const heard = strip(transcript);
  // No add/remove verb anywhere in what was heard ("milk", "I need milk",
  // "milk to my shopping list"): reject even if the model guessed an action.
  if (!hasAction("add", heard) && !hasAction("remove", heard)) {
    throw new Error(MISSING_VERB_MESSAGE);
  }
  if (isNegatedCommand(heard, command.item)) throw new Error(NEGATION_MESSAGE);
  // The list must be named by the user. A named list always wins over the model's choice.
  const list = namedList(heard, command.item);
  if (list === "none") {
    // "my work list" / "לרשימת העבודה": a list that does not exist is never guessed.
    throw new Error(MENTIONS_A_LIST.test(heard) ? LIST_MESSAGE : NO_LIST_MESSAGE);
  }
  if (list === "both") throw new Error(NO_LIST_MESSAGE);
  // Every word of the item must really have been said (no invented or misheard items).
  const heardWords = heard.split(" ");
  const itemWords = strip(command.item).split(" ").filter(Boolean);
  if (!itemWords.length || !itemWords.every((word) => wasSaid(word, heardWords))) {
    throw new Error(ITEM_MESSAGE);
  }
  // The verb in the sentence must match the action: if the user said "remove" but the
  // model returned "add" (or both verbs were said), show the command help instead.
  const opposite = command.type === "add" ? "remove" : "add";
  const phrase = strip(command.item);
  const sentence = phrase ? heard.replace(phrase, " ") : heard;
  if (!hasAction(command.type, heard) || hasAction(opposite, sentence)) {
    throw new Error(MISSING_VERB_MESSAGE);
  }
  return { ...command, list };
}

export function listHasItem(stored, item) {
  const key = normalizeItem(item);
  return Boolean(key) && storedItems(stored).some((entry) => normalizeItem(entry) === key);
}

// Returns an error message when a removal targets an item known to be missing.
export function checkRemoval(stored, command) {
  if (command.type !== "remove") return null;
  return listHasItem(stored, command.item)
    ? null
    : `“${command.item}” is not on your ${command.list === "todo" ? "to-do" : "shopping"} list.`;
}

// "add milk" twice: returns the message to show when the item is already on the list.
// Matching ignores upper/lower case, accents and punctuation. No duplicate is created.
export function checkDuplicate(stored, command) {
  if (command.type !== "add" || !listHasItem(stored, command.item)) return null;
  return `${command.item} is already on your ${command.list === "todo" ? "to-do" : "shopping"} list.`;
}

export function applyListChange(stored, command) {
  const key = normalizeItem(command.item);
  const items = storedItems(stored).filter((entry) => normalizeItem(entry) !== key);
  if (command.type === "add") items.push(command.item);
  return { tracked: true, items };
}

// Display off or offline: the display writes the time to /device/lastSeen every 10 seconds.
// After 25 seconds without it, the server answers for the display and keeps the command
// in the /commands queue, to be applied when the display is back.
export const DEVICE_ONLINE_WINDOW_MS = 25000;
export const DEVICE_OFFLINE_NOTE = "Your display is offline. The command is saved and will be applied when it is back.";

// lastSeen is epoch milliseconds (Firebase server timestamp). A missing or implausible value
// (for example the ESP32's uptime counter) means "unknown": the display is assumed online,
// so displays that do not write /device/lastSeen keep working exactly as before.
export function isDeviceOffline(lastSeen, now = Date.now()) {
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen) || lastSeen < 1e12) return false;
  return now - lastSeen > DEVICE_ONLINE_WINDOW_MS;
}

// Commands in the /commands queue that the display has not answered yet, for one list, in order.
export function pendingCommands(queue, list) {
  return Object.values(queue && typeof queue === "object" ? queue : {})
    .filter((entry) => entry && !entry.status && ["add", "remove"].includes(entry.type) &&
      entry.list === list && typeof entry.item === "string" && Number.isSafeInteger(entry.runningCount))
    .sort((a, b) => a.runningCount - b.runningCount);
}

// What the list will look like once the display catches up: the display's own array (/lists)
// plus the commands still waiting. If the display keeps no array, our tracked copy is used.
export function listWithPending(display, mine, pending) {
  if (!Array.isArray(display)) return mine ?? display;
  return pending.reduce((stored, command) => applyListChange(stored, command), display);
}

export function nextCommand(current, command) {
  const previous = current?.runningCount ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid command counter in Firebase.");
  }
  return { ...command, runningCount: previous + 1 };
}

// Each command has its own place in the /commands queue (a Firebase push id), so two phones
// sending at the same moment never overwrite each other. The display answers a command by
// writing { success, text } to /commands/<id>/status. This adapter makes that private reply
// look like the shared /status value for the same runningCount.
export function commandStatusRef(ref, runningCount) {
  const wrappers = new Map();
  return {
    on(event, callback, onError) {
      const wrapper = (snapshot) => {
        const value = snapshot.val();
        callback({ val: () => (value && typeof value === "object" ? { runningCount, ...value } : value) });
      };
      wrappers.set(callback, wrapper);
      ref.on(event, wrapper, onError);
    },
    off(event, callback) {
      const wrapper = wrappers.get(callback);
      wrappers.delete(callback);
      if (wrapper) ref.off(event, wrapper);
    }
  };
}

// Waits for the display's reply to ONE command. `refs` can be one ref or several (for example the
// command's own queue entry plus the old shared /status); the first matching reply wins.
export function waitForStatus(refs, runningCount, { timeoutMs = 60000, signal } = {}) {
  const sources = Array.isArray(refs) ? refs : [refs];
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      sources.forEach((source) => source.off("value", onValue));
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onValue = (snapshot) => {
      const value = snapshot.val();
      if (value?.runningCount === runningCount && typeof value.success === "boolean") {
        finish(null, { runningCount, success: value.success,
          text: typeof value.text === "string" ? value.text : "Display responded." });
      }
    };
    const onAbort = () => finish(new Error("Request cancelled."));
    if (signal?.aborted) return onAbort();
    timer = setTimeout(() => finish(null, null), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    sources.forEach((source) => source.on("value", onValue, (error) => finish(error)));
  });
}

// Firebase push ids are 20 characters from [-0-9A-Za-z_].
export const isPushId = (value) => typeof value === "string" && /^[-\w]{20}$/.test(value);
