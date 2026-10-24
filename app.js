const SILENCE_MESSAGE = "I didn't hear anything. Hold the button while you speak.";
const OFFLINE_MESSAGE = "You’re offline. Connect to the internet to send voice commands.";
const MIN_RECORDING_MS = 500;
const recordButton = document.getElementById("recordButton");
const undoButton = document.getElementById("undoButton");
let lastChange = null;
const statusText = document.getElementById("status");
const apiBase = window.API_BASE ?? (
  ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:3000" : ""
);
let recorder;
let holding = false;
let busy = false;
let requestingMicrophone = false;
let recordingTimer;
const stateLabel = document.getElementById("stateLabel");
const buttonTitle = document.getElementById("buttonTitle");
const recordHint = document.getElementById("recordHint");
const displayStatus = document.getElementById("displayStatus");
const codeForm = document.getElementById("codeForm");
const codeInput = document.getElementById("codeInput");

// ---------- access code (only when the server has APP_CODE set) ----------
function savedCode() {
  try { return localStorage.getItem("appCode") || ""; } catch { return ""; }
}
function apiFetch(path, options = {}) {
  const code = savedCode();
  const headers = code ? { ...options.headers, "X-App-Code": code } : options.headers;
  return fetch(`${apiBase}${path}`, { ...options, headers });
}
codeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try { localStorage.setItem("appCode", codeInput.value.trim()); } catch {}
  codeForm.hidden = true;
  codeInput.value = "";
  showState("idle", "Code saved. Hold the button to speak.");
  checkDisplay();
});

// Wake the API (cold start) and open the connection while the user reads the page.
apiFetch("/api/health", { cache: "no-store" }).catch(() => {});
function showState(state, message) {
  document.body.dataset.state = state;
  statusText.textContent = message;
  const labels = {
    idle: ["Ready", "Hold to speak", "Add or remove an item with your voice. Release to send."],
    opening: ["Microphone", "Allow microphone access", "Keep holding the button to start recording."],
    recording: ["Recording", "Listening…", "Release to send · Up to 30 seconds."],
    processing: ["Processing", "Understanding your request", "This may take a moment."],
    confirm: ["Review command", "Please check", "Choose Yes to send this command or No to cancel."],
    waiting: ["Pending", "Waiting for your display", "Your request has been sent."],
    success: ["Complete", "Done", "Hold the button to make another request."],
    error: ["Error", "Request unsuccessful", "Check the message below before trying again."],
    timeout: ["Sent", "Waiting for the display", "Your request was sent. Open “Show my lists” to check."]
  };
  [stateLabel.textContent, buttonTitle.textContent, recordHint.textContent] = labels[state];
  recordButton.setAttribute("aria-busy", String(["processing", "waiting"].includes(state)));
}

async function startRecording() {
  if (busy || requestingMicrophone || recorder?.state === "recording") return;
  if (!navigator.onLine) {
    showState("error", OFFLINE_MESSAGE);
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showState("error", "Open this app over HTTPS in Safari or Chrome to use your microphone.");
    return;
  }
  hideUndo();
  holding = true;
  requestingMicrophone = true;
  showState("opening", "Your microphone is only used while you record.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!holding) {
      stream.getTracks().forEach((track) => track.stop());
      showState("idle", "Ready when you are. Hold the button to start.");
      return;
    }
    const chunks = [];
    const current = new MediaRecorder(stream);
    recorder = current;
    current.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    current.onstop = async () => {
      clearTimeout(recordingTimer);
      stream.getTracks().forEach((track) => track.stop());
      recorder = null;
      busy = true;
      recordButton.disabled = true;
      const blob = new Blob(chunks, { type: current.mimeType });
      // A tap or an empty recording is never sent to the server.
      if (!blob.size || Date.now() - startedAt < MIN_RECORDING_MS) {
        showState("error", SILENCE_MESSAGE);
      } else {
        await sendAudio(blob);
      }
      busy = false;
      recordButton.disabled = false;
    };
    const startedAt = Date.now();
    current.start();
    recordingTimer = setTimeout(stopRecording, 30000);
    showState("recording", "Listening… release the button to send.");
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    holding = false;
    showState("error", "Could not open your microphone. Check browser permissions.");
  } finally {
    requestingMicrophone = false;
  }
}

function stopRecording() {
  holding = false;
  if (recorder?.state === "recording") {
    busy = true;
    recorder.stop();
  }
}

// An error page from the host (e.g. "502 Bad Gateway" as HTML) is not JSON: show a clear message
// instead of the browser's "Unexpected token <".
async function readJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(response.ok ? "Unexpected reply from the server. Please try again."
      : "The service isn’t answering right now. Please try again in a minute.");
  }
  // The server asks for the access code: show the code form.
  if (response.status === 401 && body?.needCode) {
    codeForm.hidden = false;
    codeInput.focus();
    throw new Error(savedCode() ? "That code didn’t work. Enter the app code again." : "Enter the app code to use this display.");
  }
  return body;
}

async function sendAudio(blob) {
  try {
    showState("processing", "Understanding your request…");
    const form = new FormData();
    const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
    form.append("audio", blob, `voice-command.${extension}`);
    const response = await apiFetch("/api/voice-command", {
      method: "POST", body: form, signal: AbortSignal.timeout(90000)
    });
    const command = await readJson(response);
    if (!response.ok) throw new Error(command.error || "Could not understand the command.");
    await sendCommand(command);
  } catch (error) {
    showRequestError(error);
  }
}

// Timeouts, a lost connection (fetch throws TypeError) and server messages look different.
function showRequestError(error) {
  if (error.name === "TimeoutError") {
    showState("timeout", "Request timed out. Check your list before trying again.");
  } else if (!navigator.onLine || error instanceof TypeError) {
    showState("error", OFFLINE_MESSAGE);
  } else {
    showState("error", error.message);
  }
}

// Undo: only offered after a command that really changed the list.
function hideUndo() {
  lastChange = null;
  undoButton.hidden = true;
}

// Sends the opposite command without a recording. The server runs the same checks and the
// same queue as for a voice command (for example, it refuses to remove an item that is gone).
async function undoLastChange() {
  if (!lastChange || busy) return;
  const { type, item, list } = lastChange;
  hideUndo();
  busy = true;
  recordButton.disabled = true;
  try {
    await sendCommand({ type: type === "add" ? "remove" : "add", item, list }, { undo: true });
  } finally {
    busy = false;
    recordButton.disabled = false;
  }
}
undoButton.addEventListener("click", undoLastChange);

// Sends the understood command straight to the display (no confirmation step).
async function sendCommand(draft, { undo = false } = {}) {
  hideUndo();
  showState("processing", undo ? "Undoing…" : "Sending your command…");
  try {
    const response = await apiFetch("/api/confirm-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
      signal: AbortSignal.timeout(15000)
    });
    const command = await readJson(response);
    if (!response.ok) throw new Error(command.error || "Could not send the command.");
    // Already on the list: nothing was sent to the display, and this still counts as success.
    if (command.duplicate) {
      showState("success", command.message);
      if (!listsBody.hidden) loadLists();
      return;
    }

    recordButton.disabled = true;
    const listName = command.list === "todo" ? "to-do list" : "shopping list";
    const removing = command.type === "remove";
    showState("waiting", `${removing ? "Removing" : "Adding"} ${command.item} ${removing ? "from" : "to"} your ${listName}…`);
    // Wait for the reply to THIS command (its own queue entry), not to another phone's.
    const confirmation = await apiFetch(`/api/command-status/${command.runningCount}?id=${encodeURIComponent(command.id)}`, {
      signal: AbortSignal.timeout(65000)
    });
    const result = await readJson(confirmation);
    if (!confirmation.ok) throw new Error(result.error || "Could not read confirmation.");
    if (!result.status) {
      showState("timeout", "Sent, but the display hasn’t confirmed yet. Open “Show my lists” to check.");
    } else {
      const itemName = command.item.charAt(0).toUpperCase() + command.item.slice(1);
      const action = removing ? "removed from" : "added to";
      showState(result.status.success ? "success" : "error", result.status.success
        ? `${itemName} ${action} your ${listName}`
        : failureText(result.status.text));
      // The list really changed: offer one Undo (not for an undo, so it cannot loop).
      if (result.status.success && !undo) {
        lastChange = { type: command.type, item: command.item, list: command.list };
        undoButton.textContent = `Undo (${command.type === "add" ? "remove" : "add back"} ${command.item})`;
        undoButton.hidden = false;
      }
    }
    checkDisplay();
    if (!listsBody.hidden) loadLists();
  } catch (error) {
    showRequestError(error);
  } finally {
    recordButton.disabled = false;
  }
}

// The display says why it couldn't do it (e.g. "Your shopping list is full"): show that.
function failureText(text) {
  if (typeof text !== "string" || !text.trim()) return "Your display couldn’t complete this request. Check your list.";
  const clean = text.trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1) + (/[.!?]$/.test(clean) ? "" : ".");
}

// Back online: clear the offline message so the user can record again.
window.addEventListener("online", () => {
  if (statusText.textContent === OFFLINE_MESSAGE && !busy) showState("idle", "");
});

recordButton.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || busy || requestingMicrophone) return;
  event.preventDefault();
  recordButton.setPointerCapture(event.pointerId);
  startRecording();
});
recordButton.addEventListener("pointerup", stopRecording);
recordButton.addEventListener("pointercancel", stopRecording);
recordButton.addEventListener("lostpointercapture", stopRecording);
recordButton.addEventListener("keydown", (event) => {
  if ([" ", "Enter"].includes(event.key)) {
    event.preventDefault();
    if (!event.repeat) startRecording();
  }
});
recordButton.addEventListener("keyup", (event) => {
  if ([" ", "Enter"].includes(event.key)) stopRecording();
});
window.addEventListener("blur", stopRecording);

// ---------- is the display online? (line above the button) ----------
function timeText(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
async function checkDisplay() {
  if (document.hidden) return;
  try {
    const response = await apiFetch("/api/display", { signal: AbortSignal.timeout(10000) });
    const display = await readJson(response);
    if (!response.ok) throw new Error();
    displayStatus.dataset.online = String(display.online && !display.needsUpdate);
    displayStatus.textContent = display.needsUpdate ? "The display needs a firmware update"
      : display.online ? "Display online"
      : display.lastSeen ? `Display offline since ${timeText(display.lastSeen)}`
      : "Display offline";
  } catch {
    displayStatus.dataset.online = "unknown";
    displayStatus.textContent = "";
  }
}
checkDisplay();
setInterval(checkDisplay, 30000);
document.addEventListener("visibilitychange", checkDisplay);

// ---------- "Type instead": the same command, typed ----------
const typeToggle = document.getElementById("typeToggle");
const typeForm = document.getElementById("typeForm");
const typeInput = document.getElementById("typeInput");
typeToggle.addEventListener("click", () => {
  typeForm.hidden = !typeForm.hidden;
  typeToggle.setAttribute("aria-expanded", String(!typeForm.hidden));
  if (!typeForm.hidden) typeInput.focus();
});
typeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = typeInput.value.trim();
  if (!text || busy) return;
  if (!navigator.onLine) return showState("error", OFFLINE_MESSAGE);
  busy = true;
  recordButton.disabled = true;
  hideUndo();
  try {
    showState("processing", "Understanding your request…");
    const response = await apiFetch("/api/text-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(90000)
    });
    const command = await readJson(response);
    if (!response.ok) throw new Error(command.error || "Could not understand the command.");
    typeInput.value = "";
    await sendCommand(command);  // same path as a voice command from here on
  } catch (error) {
    showRequestError(error);
  } finally {
    busy = false;
    recordButton.disabled = false;
  }
});

// ---------- "Show my lists" ----------
const listsToggle = document.getElementById("listsToggle");
const listsBody = document.getElementById("listsBody");
const listsNote = document.getElementById("listsNote");
function fillList(element, items) {
  element.replaceChildren(...(items.length ? items : [null]).map((name) => {
    const li = document.createElement("li");
    li.textContent = name ?? "Empty";
    if (name === null) li.className = "empty";
    else li.dir = "auto";  // Hebrew letters in the right order (rows stay left-aligned)
    return li;
  }));
}
async function loadLists() {
  try {
    const response = await apiFetch("/api/lists", { signal: AbortSignal.timeout(10000) });
    const lists = await readJson(response);
    if (!response.ok) throw new Error(lists.error || "Couldn’t load your lists right now.");
    fillList(document.getElementById("shoppingList"), lists.shopping);
    fillList(document.getElementById("todoList"), lists.todo);
    document.getElementById("shoppingCount").textContent = lists.shopping.length;
    document.getElementById("todoCount").textContent = lists.todo.length;
    listsNote.textContent = displayStatus.dataset.online === "false"
      ? "Includes changes the display will make when it reconnects." : "";
  } catch (error) {
    listsNote.textContent = error.name === "TimeoutError" || error instanceof TypeError
      ? "Couldn’t load your lists right now." : error.message;
  }
}
listsToggle.addEventListener("click", () => {
  listsBody.hidden = !listsBody.hidden;
  listsToggle.setAttribute("aria-expanded", String(!listsBody.hidden));

  if (!listsBody.hidden) loadLists();
});
