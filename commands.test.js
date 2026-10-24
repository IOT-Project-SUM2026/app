import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCommand, nextCommand, waitForStatus, verifyTranscript, checkRemoval, applyListChange
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
  for (const value of [null, {}, { action: "erase", item: "milk", list: "shopping" },
    { action: "add", item: " ", list: "shopping" }, { action: "add", item: "milk", list: "other" }]) {
    assert.throws(() => validateCommand(value));
  }
  assert.throws(() => validateCommand({ action: "add", item: "temperature", list: "temp" }),
    /shopping list or to-do list/);
  assert.throws(() => validateCommand({ action: null, item: "Chico", list: null }),
    /whether to add or remove/);
  assert.throws(() => validateCommand({ action: "add", item: "Chico", list: null }),
    /shopping list or to-do list/);
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
