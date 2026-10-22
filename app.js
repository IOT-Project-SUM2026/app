const recordButton = document.getElementById("recordButton");
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
const commandReview = document.getElementById("commandReview");
const reviewCommand = document.getElementById("reviewCommand");
const confirmCommandButton = document.getElementById("confirmCommand");
const cancelCommandButton = document.getElementById("cancelCommand");
let pendingCommand = null;
// Wake the API (cold start) and open the connection while the user reads the page.
fetch(`${apiBase}/api/health`, { cache: "no-store" }).catch(() => {});
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
    timeout: ["Not confirmed", "No response yet", "Check your list before trying again."]
  };
  [stateLabel.textContent, buttonTitle.textContent, recordHint.textContent] = labels[state];
  recordButton.setAttribute("aria-busy", String(["processing", "waiting"].includes(state)));
}

async function startRecording() {
  if (busy || pendingCommand || requestingMicrophone || recorder?.state === "recording") return;
  if (!navigator.onLine) {
    showState("error", "You’re offline. Connect to the internet to record a command.");
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showState("error", "Open this app over HTTPS in Safari or Chrome to use your microphone.");
    return;
  }
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
      await sendAudio(new Blob(chunks, { type: current.mimeType }));
      busy = false;
      recordButton.disabled = Boolean(pendingCommand);
    };
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

async function sendAudio(blob) {
  try {
    if (!blob.size) throw new Error("No audio recorded. Hold the button and try again.");
    showState("processing", "Understanding your request…");
    const form = new FormData();
    const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
    form.append("audio", blob, `voice-command.${extension}`);
    const response = await fetch(`${apiBase}/api/voice-command`, {
      method: "POST", body: form, signal: AbortSignal.timeout(90000)
    });
    const command = await response.json();
    if (!response.ok) throw new Error(command.error || "Could not understand the command.");
    const listName = command.list === "todo" ? "to-do list" : "shopping list";
    pendingCommand = command;
    const action = command.type === "remove" ? "Remove" : "Add";
    const relation = command.type === "remove" ? "from" : "to";
    reviewCommand.textContent = `${action} “${command.item}” ${relation} your ${listName}?`;
    commandReview.hidden = false;
    recordButton.disabled = true;
    showState("confirm", "Nothing has been sent to your display yet.");
    confirmCommandButton.focus();
  } catch (error) {
    showState(error.name === "TimeoutError" ? "timeout" : "error", error.name === "TimeoutError"
      ? "Request timed out. Check your list before trying again."
      : error.message);
  }
}

async function confirmCommand() {
  if (!pendingCommand || busy) return;
  busy = true;
  confirmCommandButton.disabled = true;
  cancelCommandButton.disabled = true;
  const draft = pendingCommand;
  showState("processing", "Sending your confirmed command…");
  try {
    const response = await fetch(`${apiBase}/api/confirm-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
      signal: AbortSignal.timeout(15000)
    });
    const command = await response.json();
    if (!response.ok) throw new Error(command.error || "Could not send the command.");

    pendingCommand = null;
    commandReview.hidden = true;
    confirmCommandButton.disabled = false;
    cancelCommandButton.disabled = false;
    recordButton.disabled = true;
    const listName = command.list === "todo" ? "to-do list" : "shopping list";
    const removing = command.type === "remove";
    showState("waiting", `${removing ? "Removing" : "Adding"} ${command.item} ${removing ? "from" : "to"} your ${listName}…`);
    const confirmation = await fetch(`${apiBase}/api/command-status/${command.runningCount}`, {
      signal: AbortSignal.timeout(65000)
    });
    const result = await confirmation.json();
    if (!confirmation.ok) throw new Error(result.error || "Could not read confirmation.");
    if (!result.status) {
      showState("timeout", "The display hasn’t confirmed yet. Check your list before trying again.");
    } else {
      const itemName = command.item.charAt(0).toUpperCase() + command.item.slice(1);
      const action = removing ? "removed from" : "added to";
      showState(result.status.success ? "success" : "error", result.status.success
        ? `${itemName} ${action} your ${listName}`
        : "Your display couldn’t complete this request. Check your list.");
    }
  } catch (error) {
    if (pendingCommand) {
      pendingCommand = null;
      commandReview.hidden = true;
      showState("error", "Could not confirm whether the command was sent. Check your list before trying again.");
    } else {
      showState(error.name === "TimeoutError" ? "timeout" : "error", error.name === "TimeoutError"
        ? "Request timed out. Check your list before trying again."
        : error.message);
    }
  } finally {
    busy = false;
    confirmCommandButton.disabled = false;
    cancelCommandButton.disabled = false;
    recordButton.disabled = Boolean(pendingCommand);
  }
}

function cancelCommand() {
  if (!pendingCommand || busy) return;
  pendingCommand = null;
  commandReview.hidden = true;
  showState("idle", "Canceled. Nothing was sent to your display.");
  recordButton.disabled = false;
  recordButton.focus();
}

confirmCommandButton.addEventListener("click", confirmCommand);
cancelCommandButton.addEventListener("click", cancelCommand);

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
