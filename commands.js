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

export const SILENCE_MESSAGE = "I didn't hear anything. Hold the button while you speak.";
export const UNCLEAR_MESSAGE = "I couldn't understand that.";

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
  if (!value || typeof value !== "object") {
    throw new Error("Could not understand a valid command. Please try again.");
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

export function applyListChange(stored, command) {
  const key = normalizeItem(command.item);
  const items = storedItems(stored).filter((entry) => normalizeItem(entry) !== key);
  if (command.type === "add") items.push(command.item);
  return { tracked: true, items };
}

export function nextCommand(current, command) {
  const previous = current?.runningCount ?? 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid command counter in Firebase.");
  }
  return { ...command, runningCount: previous + 1 };
}

export function waitForStatus(ref, runningCount, { timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      ref.off("value", onValue);
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
    ref.on("value", onValue, (error) => finish(error));
  });
}
