export function validateCommand(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Could not understand a valid command. Please try again.");
  }
  const type = value.action ?? value.type;
  if (!["add", "remove"].includes(type)) {
    throw new Error("Please say whether to add or remove the item, and name the shopping or to-do list.");
  }
  if (!["shopping", "todo"].includes(value.list)) {
    throw new Error("I can only use the shopping list or to-do list. Please say which one.");
  }
  if (typeof value.item !== "string" || !value.item.trim() || value.item.length > 200) {
    throw new Error("Could not understand a valid command. Please try again.");
  }
  return { type, item: value.item.trim(), list: value.list };
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

// The model must prove what it heard: the transcript has to contain an explicit
// action word, an explicit list name and the item. Prevents "bro" -> add.
export function verifyTranscript(transcript, command) {
  const heard = strip(transcript);
  const itemWords = strip(command.item).split(" ").filter(Boolean);
  if (!heard || !ACTION_WORDS[command.type].test(heard) ||
      !LIST_WORDS[command.list].test(heard) || !itemWords.every((word) => heard.includes(word))) {
    throw new Error("Please say the action, the item and the list, for example: add milk to my shopping list.");
  }
  return command;
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
