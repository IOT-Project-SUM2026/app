import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCommand, nextCommand, waitForStatus, verifyTranscript, checkRemoval, applyListChange, checkHeard, checkDuplicate, retryWhileBusy, commandStatusRef, isPushId,
  withTimeout, GEMINI_TIMEOUT_MS, BUSY_MESSAGE
} from "./commands.js";

function fakeRef() {
  let handler;
  return {
    on(_event, callback) { handler = callback; },
    off() { handler = undefined; },
    emit(value) { handler?.({ val: () => value }); },
    get listening() { return Boolean(handler); }
  };
}

test("validates commands before mapping them to the device format", () => {
  assert.deepEqual(validateCommand({ action: "add", item: " tomato ", list: "shopping" }),
    { type: "add", item: "tomato", list: "shopping" });
  assert.deepEqual(validateCommand({ action: "add", item: "call the dentist", list: "todo" }),
    { type: "add", item: "call the dentist", list: "todo" });
  assert.deepEqual(validateCommand({ type: "remove", item: "milk", list: "shopping" }),
    { type: "remove", item: "milk", list: "shopping" });
  // Gemini's reply is not a usable command object: "Could not understand a valid command."
  for (const value of [null, undefined, "text", 5, []]) {
    assert.throws(() => validateCommand(value), /Could not understand a valid command\. Please try again\./);
  }
  for (const value of [null, {}, { action: "erase", item: "milk", list: "shopping" },
    { action: "add", item: " ", list: "shopping" }, { action: "add", item: "milk", list: "other" }]) {
    assert.throws(() => validateCommand(value));
  }
  assert.throws(() => validateCommand({ action: "add", item: "temperature", list: "temp" }),
    /There are two lists: shopping and to-do\./);
  assert.throws(() => validateCommand({ action: null, item: "Chico", list: null }),
    /Say “add” or “remove”/);
  assert.throws(() => validateCommand({ action: "add", item: "Chico", list: null }),
    /Say which list/);
});

test("the list must be named; a named list wins over the model's choice", () => {
  const ask = /Say which list: “to my shopping list” or “to my to-do list”\./;
  // No list named, even though the model picked one ("cooking" could be either).
  for (const [heard, item] of [["add bread", "bread"], ["add cooking", "cooking"], ["תוסיף ריצה", "ריצה"]]) {
    for (const list of ["shopping", "todo"]) {
      assert.throws(() => verifyTranscript(heard, { type: "add", item, list }), ask);
    }
  }
  // The model returned no list at all.
  assert.throws(() => validateCommand({ action: "add", item: "bread", list: null }), ask);
  assert.throws(() => validateCommand({ action: "add", item: "bread" }), ask);
  // Both lists named: ambiguous, so ask.
  assert.throws(() => verifyTranscript("add bread to my shopping list and to-do list",
    { type: "add", item: "bread", list: "shopping" }), ask);
  // The user said shopping, the model said todo: the user wins.
  assert.deepEqual(verifyTranscript("add bread to my shopping list",
    { type: "add", item: "bread", list: "todo" }), { type: "add", item: "bread", list: "shopping" });
  assert.deepEqual(verifyTranscript("תוסיף ריצה לרשימת המשימות",
    { type: "add", item: "ריצה", list: "shopping" }), { type: "add", item: "ריצה", list: "todo" });
  // An item that contains a list word is not a named list.
  assert.deepEqual(verifyTranscript("add shopping bag to my to-do list",
    { type: "add", item: "shopping bag", list: "shopping" }), { type: "add", item: "shopping bag", list: "todo" });
  assert.throws(() => verifyTranscript("add shopping bag", { type: "add", item: "shopping bag", list: "shopping" }), ask);
  // checkHeard fills the list from the transcript when the model returned null.
  assert.equal(checkHeard({ transcript: "add bread to my to do list", action: "add", item: "bread", list: null }).list, "todo");
  assert.equal(checkHeard({ transcript: "add bread", action: "add", item: "bread", list: null }).list, null);
});

test("the spoken verb must match the action the model returned", () => {
  const help = /Say “add” or “remove”, then one item, e\.g\. “Add milk to my shopping list”\./;
  const add = { type: "add", item: "milk", list: "shopping" };
  const remove = { ...add, type: "remove" };
  // Said "remove", the model returned "add" (and the reverse).
  assert.throws(() => verifyTranscript("remove milk from my shopping list", add), help);
  assert.throws(() => verifyTranscript("add milk to my shopping list", remove), help);
  assert.throws(() => verifyTranscript("תמחק חלב מרשימת הקניות", { ...add, item: "חלב" }), help);
  assert.throws(() => verifyTranscript("תוסיף חלב לרשימת הקניות", { ...remove, item: "חלב" }), help);
  assert.throws(() => verifyTranscript("supprime le lait de ma liste de courses", { ...add, item: "lait" }), help);
  // Both verbs in one sentence is ambiguous.
  assert.throws(() => verifyTranscript("add milk and remove milk from my shopping list", add), help);
  // Matching verbs pass; a verb word inside the item is not a second verb.
  assert.deepEqual(verifyTranscript("remove milk from my shopping list", remove), remove);
  assert.deepEqual(verifyTranscript("delete milk from my shopping list", remove), remove);
  verifyTranscript("add clear glass to my shopping list", { ...add, item: "clear glass" });
  verifyTranscript("remove put out the trash from my to-do list", { type: "remove", item: "put out the trash", list: "todo" });
});

test("strange but explicit items are accepted: the sentence structure decides", () => {
  for (const [heard, item, list] of [
    ["add where are you to my shopping list", "where are you", "shopping"],
    ["add hello to my shopping list", "hello", "shopping"],
    ["add what time is it to my to-do list", "what time is it", "todo"],
    ["add how are you today to my to do list", "how are you today", "todo"],
    ["תוסיף איפה אתה לרשימת הקניות", "איפה אתה", "shopping"],
    ["add bro to my shopping list", "bro", "shopping"]
  ]) {
    const command = { type: "add", item, list };
    assert.deepEqual(validateCommand({ action: "add", item, list }), command);
    assert.deepEqual(verifyTranscript(heard, command), command);
    assert.deepEqual(checkHeard({ transcript: heard, action: "add", item, list }),
      { transcript: heard, action: "add", item, list });
  }
  // Without the verb or the list, the same words are still rejected.
  assert.throws(() => verifyTranscript("where are you", { type: "add", item: "where are you", list: "shopping" }),
    /Say “add” or “remove”/);
  assert.throws(() => verifyTranscript("add where are you", { type: "add", item: "where are you", list: "shopping" }),
    /Say which list/);
});

test("item length, filler-only items, leading fillers and punctuation", () => {
  const ok = (item, list = "shopping") => validateCommand({ action: "add", item, list }).item;
  // Too long: more than 40 characters, or more than 47 bytes (Hebrew letters take 2 bytes).
  assert.equal(ok("a".repeat(40)), "a".repeat(40));
  assert.throws(() => validateCommand({ action: "add", item: "a".repeat(41), list: "shopping" }),
    /That item is too long\./);
  assert.throws(() => validateCommand({ action: "add", item: "ה".repeat(30), list: "shopping" }),
    /That item is too long\./);
  assert.equal(ok("ה".repeat(23)), "ה".repeat(23));
  // Only filler words, or nothing at all.
  for (const item of ["the", "a", "my", "some", "the a", "the the", "to my", "את", " ", ".", "", null, undefined, 5]) {
    assert.throws(() => validateCommand({ action: "add", item, list: "shopping" }),
      /I couldn't make out the item\./);
  }
  // Leading fillers are dropped, punctuation is ignored, capitals are kept.
  assert.equal(ok("the Milk."), "Milk");
  assert.equal(ok("Please the Milk!"), "Milk");
  assert.equal(ok("some  Milk,"), "Milk");
  assert.equal(ok("  “Milk”  "), "Milk");
  assert.equal(ok("a glass of water"), "glass of water");
  assert.equal(ok("du lait"), "lait");
  assert.equal(ok("the חלב."), "חלב");
  assert.equal(ok("mac and cheese"), "mac and cheese");
  // The spoken sentence still verifies against the cleaned item.
  const command = validateCommand({ action: "add", item: "the Milk.", list: "shopping" });
  assert.deepEqual(verifyTranscript("Please add the Milk. to my shopping list", command),
    { type: "add", item: "Milk", list: "shopping" });
});

test("a spoken verb with no usable item reports the item, not the verb", () => {
  // Real case: the user said "Add the"; the model returned null for everything else.
  const heard = checkHeard({ transcript: "Add the", action: null, item: null, multipleItems: false, list: null });
  assert.equal(heard.action, "add");
  assert.throws(() => validateCommand(heard), /I couldn't make out the item\./);
  const remove = checkHeard({ transcript: "remove", action: null, item: null, list: null });
  assert.equal(remove.action, "remove");
  assert.throws(() => validateCommand(remove), /I couldn't make out the item\./);
  assert.throws(() => validateCommand(checkHeard({ transcript: "add to my shopping list", action: null, item: null, list: null })),
    /I couldn't make out the item\./);
  // No verb said: nothing is filled in, so the help message is shown.
  const none = checkHeard({ transcript: "the milk", action: null, item: "milk", list: null });
  assert.equal(none.action, null);
  assert.throws(() => validateCommand(none), /Say “add” or “remove”/);
  // Both verbs said: not filled in either (ambiguous).
  assert.equal(checkHeard({ transcript: "add and remove milk", action: null, item: "milk", list: null }).action, null);
  // A real item with the verb filled in and a list named works.
  const ok = checkHeard({ transcript: "add milk to my shopping list", action: null, item: "milk", list: null });
  assert.deepEqual(validateCommand(ok), { type: "add", item: "milk", list: "shopping" });
});

test("Gemini busy (503): retries 3 times, 2 seconds apart, then reports an error", async () => {
  const busy = () => Object.assign(new Error("overloaded"), { status: 503 });
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  // Always busy: 1 first try + 3 retries, each retry after 2 seconds, then the 503 is thrown.
  let calls = 0;
  await assert.rejects(retryWhileBusy(async () => { calls++; throw busy(); }, { sleep }),
    (error) => error.status === 503);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [2000, 2000, 2000]);
  // Busy twice, then it works: the answer is returned without more waiting.
  calls = 0; waits.length = 0;
  const answer = await retryWhileBusy(async () => {
    if (++calls < 3) throw busy();
    return "ok";
  }, { sleep });
  assert.equal(answer, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 2000]);
  // Other errors are not retried.
  calls = 0; waits.length = 0;
  await assert.rejects(retryWhileBusy(async () => { calls++; throw Object.assign(new Error("bad"), { status: 400 }); }, { sleep }),
    (error) => error.status === 400);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  // Default timing is 2 seconds.
  const seen = [];
  let tries = 0;
  await retryWhileBusy(async () => { if (++tries < 2) throw busy(); }, {
    sleep: async (ms) => { seen.push(ms); }, onRetry: (attempt, retries) => seen.push(`retry ${attempt}/${retries}`)
  });
  assert.deepEqual(seen, ["retry 1/3", 2000]);
});

test("Gemini that never answers is cancelled after the time limit", async () => {
  // A call that hangs: it is cancelled (aborted) and reported as a timeout.
  let aborted = false;
  const started = Date.now();
  await assert.rejects(withTimeout((signal) => new Promise(() => {
    signal.addEventListener("abort", () => { aborted = true; });
  }), 30), (error) => error.code === "GEMINI_TIMEOUT");
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000);
  // A call that answers in time is returned untouched.
  assert.equal(await withTimeout(async () => "heard it", 1000), "heard it");
  // Errors from the call itself pass through.
  await assert.rejects(withTimeout(async () => { throw Object.assign(new Error("x"), { status: 400 }); }, 1000),
    (error) => error.status === 400);
  // The limit is 20 seconds and the message matches what the user sees.
  assert.equal(GEMINI_TIMEOUT_MS, 20000);
  assert.equal(BUSY_MESSAGE, "The voice service is busy right now. Please try again in a moment.");
  // A timeout is not retried like a 503 (it would multiply the wait).
  let calls = 0;
  await assert.rejects(retryWhileBusy(() => withTimeout(async () => { calls++; return new Promise(() => {}); }, 20),
    { sleep: async () => {} }), (error) => error.code === "GEMINI_TIMEOUT");
  assert.equal(calls, 1);
});

test("adding an item that is already on the list creates no duplicate", () => {
  const add = (item, list = "shopping") => ({ type: "add", item, list });
  // Plain array kept by the display, and our own tracked { items } copy.
  const display = ["Milk", "eggs"];
  assert.equal(checkDuplicate(display, add("milk")), "milk is already on your shopping list.");
  assert.equal(checkDuplicate(display, add("MILK")), "MILK is already on your shopping list.");
  assert.equal(checkDuplicate({ tracked: true, items: ["Milk"] }, add("milk")), "milk is already on your shopping list.");
  assert.equal(checkDuplicate(["call my mom"], add("Call My Mom", "todo")), "Call My Mom is already on your to-do list.");
  assert.equal(checkDuplicate(["הליכה"], add("הליכה", "todo")), "הליכה is already on your to-do list.");
  // Not on the list, empty or unknown lists, and removals are not duplicates.
  assert.equal(checkDuplicate(display, add("bread")), null);
  assert.equal(checkDuplicate(null, add("milk")), null);
  assert.equal(checkDuplicate(undefined, add("milk")), null);
  assert.equal(checkDuplicate(display, { type: "remove", item: "milk", list: "shopping" }), null);
  // Adding twice through the tracked copy never stores two entries.
  let stored = applyListChange(null, add("milk"));
  assert.equal(checkDuplicate(stored, add("Milk")), "Milk is already on your shopping list.");
  stored = applyListChange(stored, add("Milk"));
  assert.equal(stored.items.length, 1);
});

test("two phones sending at the same moment each get the reply to their own command", async () => {
  // A tiny fake Firebase: values by path, with real per-callback listeners.
  const values = {};
  const listeners = new Map();
  const ref = (path) => ({
    on(_event, callback) { listeners.set(path, [...(listeners.get(path) ?? []), callback]); },
    off(_event, callback) { listeners.set(path, (listeners.get(path) ?? []).filter((item) => item !== callback)); },
    set(value) { values[path] = value; (listeners.get(path) ?? []).forEach((cb) => cb({ val: () => value })); }
  });
  const count = (path) => (listeners.get(path) ?? []).length;

  // Two commands sent at the same moment: numbers are unique and each has its own queue entry.
  const first = nextCommand(null, { type: "add", item: "milk", list: "shopping" });
  const second = nextCommand(first, { type: "add", item: "eggs", list: "shopping" });
  assert.deepEqual([first.runningCount, second.runningCount], [1, 2]);
  const idA = `-O${"a".repeat(17)}A`;
  const idB = `-O${"b".repeat(17)}B`;
  assert.equal(idA.length, 20);
  assert.ok(isPushId(idA) && isPushId(idB));
  for (const bad of ["", "abc", "-Oaaa/../status", "x".repeat(21), 5, null, undefined]) {
    assert.equal(isPushId(bad), false);
  }

  // Both phones wait at the same time: each on its own queue entry plus the shared /status.
  const waitFor = (id, runningCount) => waitForStatus(
    [commandStatusRef(ref(`commands/${id}/status`), runningCount), ref("status")], runningCount);
  const phoneA = waitFor(idA, 1);
  const phoneB = waitFor(idB, 2);
  assert.equal(count(`commands/${idA}/status`), 1);
  assert.equal(count(`commands/${idB}/status`), 1);
  assert.equal(count("status"), 2);

  // The display answers B first, then A, each in that command's own place. Nothing is overwritten.
  ref(`commands/${idB}/status`).set({ success: true, text: "eggs added" });
  assert.deepEqual(await phoneB, { runningCount: 2, success: true, text: "eggs added" });
  ref(`commands/${idA}/status`).set({ success: false, text: "milk failed" });
  assert.deepEqual(await phoneA, { runningCount: 1, success: false, text: "milk failed" });
  // Every listener is removed afterwards.
  assert.equal(count(`commands/${idA}/status`) + count(`commands/${idB}/status`) + count("status"), 0);

  // Older displays that only write the shared /status are still understood, per runningCount.
  const legacyA = waitFor(idA, 1);
  const legacyB = waitFor(idB, 2);
  ref("status").set({ runningCount: 2, success: true, text: "B done" });
  assert.deepEqual(await legacyB, { runningCount: 2, success: true, text: "B done" });
  ref("status").set({ runningCount: 1, success: true, text: "A done" });
  assert.deepEqual(await legacyA, { runningCount: 1, success: true, text: "A done" });

  // A reply written for the other phone's command is ignored, however late it arrives.
  const lonely = waitForStatus([commandStatusRef(ref(`commands/${idA}/status`), 1)], 1, { timeoutMs: 20 });
  ref(`commands/${idB}/status`).set({ success: true, text: "not for A" });
  assert.equal(await lonely, null);
  assert.equal(count(`commands/${idA}/status`), 0);
});

test("an item that was not said is rejected", () => {
  const unclear = /I couldn't make out the item\./;
  const shop = (item) => ({ type: "add", item, list: "shopping" });
  // The model invented or misheard the item.
  assert.throws(() => verifyTranscript("add milk to my shopping list", shop("eggs")), unclear);
  assert.throws(() => verifyTranscript("add milk to my shopping list", shop("milk chocolate")), unclear);
  assert.throws(() => verifyTranscript("add butter milk to my shopping list", shop("buttermilk")), unclear);
  assert.throws(() => verifyTranscript("add buttermilk to my shopping list", shop("milk")), unclear);
  assert.throws(() => verifyTranscript("תוסיף חלב לרשימת הקניות", shop("ביצים")), unclear);
  // Verb and list are fine, but nothing was said as the item.
  assert.throws(() => verifyTranscript("add to my shopping list", shop("milk")), unclear);
  // Said items pass, in any word order, with accents, and with Hebrew prefixes.
  verifyTranscript("add Milk to my shopping list", shop("milk"));
  verifyTranscript("add call the dentist to my to-do list", { type: "add", item: "dentist call", list: "todo" });
  verifyTranscript("ajoute du lait à ma liste de courses", shop("lait"));
  verifyTranscript("תוסיף את החלב לרשימת הקניות", shop("חלב"));
  verifyTranscript("תוסיף ללכת לרופא לרשימת המשימות", { type: "add", item: "לרופא", list: "todo" });
});

test("a list that does not exist is rejected instead of guessed", () => {
  const twoLists = /There are two lists: shopping and to-do\./;
  assert.throws(() => validateCommand({ action: "add", item: "milk", list: "work" }), twoLists);
  assert.throws(() => validateCommand({ action: "add", item: "חלב", list: "עבודה" }), twoLists);
  // The model guessed "todo"/"shopping", but the user said another list.
  assert.throws(() => verifyTranscript("add milk to my work list",
    { type: "add", item: "milk", list: "todo" }), twoLists);
  assert.throws(() => verifyTranscript("add milk to my work list",
    { type: "add", item: "milk", list: "shopping" }), twoLists);
  assert.throws(() => verifyTranscript("תוסיף חלב לרשימת העבודה",
    { type: "add", item: "חלב", list: "shopping" }), twoLists);
  assert.throws(() => verifyTranscript("ajoute du lait à ma liste de travail",
    { type: "add", item: "lait", list: "shopping" }), twoLists);
  // Real lists still work.
  verifyTranscript("add milk to my shopping list", { type: "add", item: "milk", list: "shopping" });
  verifyTranscript("add milk to the grocery list", { type: "add", item: "milk", list: "shopping" });
  verifyTranscript("תוסיף חלב לרשימת הקניות", { type: "add", item: "חלב", list: "shopping" });
  verifyTranscript("add dentist to my to do list", { type: "add", item: "dentist", list: "todo" });
});

test("rejects commands the user did not actually say", () => {
  const add = { type: "add", item: "milk", list: "shopping" };
  assert.deepEqual(verifyTranscript("Add milk to my shopping list", add), add);
  assert.throws(() => verifyTranscript("bro", { type: "add", item: "bro", list: "shopping" }));
  assert.throws(() => verifyTranscript("milk", add));
  assert.throws(() => verifyTranscript("add milk", add));
  assert.throws(() => verifyTranscript("remove milk from my shopping list", add));
  verifyTranscript("ajoute du lait à ma liste de courses", { type: "add", item: "lait", list: "shopping" });
  verifyTranscript("add call the dentist to my to-do list", { type: "add", item: "call the dentist", list: "todo" });
});

test("accepts Hebrew commands and rejects Hebrew without a verb", () => {
  const add = { type: "add", item: "חלב", list: "shopping" };
  assert.deepEqual(verifyTranscript("תוסיף חלב לרשימת הקניות", add), add);
  assert.deepEqual(verifyTranscript("הוסף חלב לרשימת קניות", add), add);
  verifyTranscript("תמחק חלב מרשימת הקניות", { type: "remove", item: "חלב", list: "shopping" });
  verifyTranscript("תוסיף ללכת לרופא לרשימת המשימות", { type: "add", item: "ללכת לרופא", list: "todo" });
  verifyTranscript("תוסיף ריצה לרשימת מה לעשות", { type: "add", item: "ריצה", list: "todo" });
  for (const heard of ["חלב", "אני צריך חלב", "חלב לרשימת הקניות"]) {
    assert.throws(() => verifyTranscript(heard, add), /Say “add” or “remove”/);
  }
  assert.throws(() => verifyTranscript("תוסיף חלב", add), /Say which list/);
  // The user named the shopping list, so it wins over the model's "todo".
  assert.deepEqual(verifyTranscript("תוסיף חלב לרשימת הקניות", { ...add, list: "todo" }), add);
  assert.throws(() => verifyTranscript("תמחק חלב מרשימת הקניות", add));
});

test("rejects a missing add/remove verb even when the model guessed an action", () => {
  const add = { type: "add", item: "milk", list: "shopping" };
  for (const heard of ["milk to my shopping list", "I need milk", "milk", "", null,
    "hello", "what time is it", "how are you today", "מה השעה", "שלום"]) {
    assert.throws(() => verifyTranscript(heard, add),
      /Say “add” or “remove”, then one item, e\.g\. “Add milk to my shopping list”\./);
  }
  // Small talk where Gemini returns no action, item or list at all is rejected too.
  assert.throws(() => validateCommand({ action: null, item: null, list: null }),
    /Say “add” or “remove”/);
  // A verb for the other action keeps the generic message.
  assert.throws(() => verifyTranscript("remove milk from my shopping list", add),
    /Say “add” or “remove”, then one item/);
});

test("silence, noise and cut-off recordings are rejected before anything is sent", () => {
  for (const parsed of [{ transcript: "", action: null, item: null, list: null },
    { transcript: "   ", action: "add", item: "milk", list: "shopping" },
    { action: "add", item: "milk", list: "shopping" }, { transcript: null }]) {
    assert.throws(() => checkHeard(parsed), /I didn't hear anything\. Hold the button while you speak\./);
  }
  for (const parsed of [null, "text", [], undefined]) {
    assert.throws(() => checkHeard(parsed), /Could not understand a valid command\. Please try again\./);
  }
  const heard = { transcript: "add milk to my shopping list", action: "add", item: "milk", list: "shopping" };
  assert.deepEqual(checkHeard(heard), heard);
});

test("several items are rejected, but one item containing \"and\" is accepted", () => {
  const base = { action: "add", list: "shopping" };
  for (const value of [
    { ...base, item: "milk and eggs", multipleItems: true },
    { ...base, item: "milk, eggs", multipleItems: false },
    { ...base, item: "milk, eggs and bread" },
    { ...base, item: "חלב, ביצים" },
    { ...base, item: "חלב וביצים", multipleItems: true }
  ]) {
    assert.throws(() => validateCommand(value), /One item at a time, please\./);
  }
  assert.deepEqual(validateCommand({ ...base, item: "mac and cheese", multipleItems: false }),
    { type: "add", item: "mac and cheese", list: "shopping" });
  assert.deepEqual(validateCommand({ ...base, item: "salt and pepper" }),
    { type: "add", item: "salt and pepper", list: "shopping" });
});

test("negated commands are rejected with \"Nothing was changed.\"", () => {
  const add = { type: "add", item: "milk", list: "shopping" };
  for (const heard of ["don't add milk to my shopping list", "do not add milk to my shopping list",
    "never add milk to my shopping list", "please do not add milk to my shopping list",
    "n'ajoute pas du lait à ma liste de courses"]) {
    assert.throws(() => verifyTranscript(heard, add), /Nothing was changed\./);
  }
  assert.throws(() => verifyTranscript("אל תוסיף חלב לרשימת הקניות", { ...add, item: "חלב" }),
    /Nothing was changed\./);
  assert.throws(() => verifyTranscript("לא להוסיף חלב לרשימת הקניות", { ...add, item: "חלב" }),
    /Nothing was changed\./);
  assert.throws(() => verifyTranscript("don't remove milk from my shopping list", { ...add, type: "remove" }),
    /Nothing was changed\./);
  // Even when the model already returned action null, the user hears "Nothing was changed."
  assert.throws(() => checkHeard({ transcript: "don't add milk to my shopping list", action: null, item: "milk", list: null }),
    /Nothing was changed\./);
  assert.throws(() => checkHeard({ transcript: "אל תוסיף חלב", action: null, item: "חלב", list: null }),
    /Nothing was changed\./);
  assert.doesNotThrow(() => checkHeard({ transcript: "add no salt crackers to my shopping list", item: "no salt crackers" }));
  // Words that are part of the item are not negation; normal commands still pass.
  verifyTranscript("add no salt crackers to my shopping list", { ...add, item: "no salt crackers" });
  verifyTranscript("add notebook to my shopping list", { ...add, item: "notebook" });
  verifyTranscript("add milk to my shopping list", add);
});

test("removing a missing item is refused; lists stay in sync", () => {
  const remove = { type: "remove", item: "Milk", list: "shopping" };
  assert.match(checkRemoval(null, remove), /not on your shopping list/);
  assert.match(checkRemoval(null, { ...remove, item: "shoes", list: "todo" }), /not on your to-do list/);
  assert.equal(checkRemoval(null, { type: "add", item: "milk", list: "todo" }), null);
  const display = ["cooking", "call my mom", "הליכה"];
  assert.equal(checkRemoval(display, { type: "remove", item: "Call my mom", list: "todo" }), null);
  assert.equal(checkRemoval(display, { type: "remove", item: "הליכה", list: "todo" }), null);
  assert.match(checkRemoval(display, { type: "remove", item: "shoes", list: "todo" }), /not on your to-do list/);
  assert.match(checkRemoval(display, { type: "remove", item: "ריצה", list: "todo" }), /not on your to-do list/);
  let stored = applyListChange(null, { type: "add", item: "milk", list: "shopping" });
  assert.equal(checkRemoval(stored, remove), null);
  stored = applyListChange(stored, remove);
  assert.match(checkRemoval(stored, remove), /not on your shopping list/);
});

test("identical commands receive increasing numbers; invalid counters are rejected", () => {
  const command = { type: "add", item: "tomato", list: "shopping" };
  const first = nextCommand(null, command);
  assert.equal(first.runningCount, 1);
  assert.equal(nextCommand(first, command).runningCount, 2);
  assert.throws(() => nextCommand({ runningCount: "1" }, command));
});

test("ignores old and malformed confirmations, then accepts matching failure", async () => {
  const ref = fakeRef();
  const pending = waitForStatus(ref, 2);
  ref.emit({ runningCount: 1, success: true });
  ref.emit({ runningCount: 2, success: "true" });
  assert.equal(ref.listening, true);
  ref.emit({ runningCount: 2, success: false, text: "Item missing" });
  assert.deepEqual(await pending, { runningCount: 2, success: false, text: "Item missing" });
  assert.equal(ref.listening, false);
});

test("timeout and disconnect remove Firebase listeners", async () => {
  const ref = fakeRef();
  assert.equal(await waitForStatus(ref, 1, { timeoutMs: 5 }), null);
  assert.equal(ref.listening, false);
  const controller = new AbortController();
  const pending = waitForStatus(ref, 1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(ref.listening, false);
});
