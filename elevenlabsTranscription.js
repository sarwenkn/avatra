(function () {
const transcriptPanel = document.getElementById("live-transcript-panel");
const transcriptStatus = document.getElementById("live-transcript-status");
const transcriptActive = document.getElementById("live-transcript-active");
const transcriptHistory = document.getElementById("live-transcript-history");
const anamContainer = document.getElementById("anam-container");

if (!transcriptPanel || !transcriptStatus || !transcriptActive || !transcriptHistory || !anamContainer) {
return;
}

// WARNING: This exposes your ElevenLabs API key in the browser bundle.
// Use only if you accept client-side key exposure.
const ELEVENLABS_API_KEY = "sk_4d175a2b16fc1fc520ca4690723fba27ce8467cfe42e8585";
const ELEVENLABS_API_KEY_PLACEHOLDER = "PASTE_YOUR_ELEVENLABS_API_KEY_HERE";
const ELEVENLABS_TOKEN_ENDPOINT = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const WS_BASE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MODEL_ID = "scribe_v2_realtime";
const SAMPLE_RATE = 16000;
const AUTO_STOP_AFTER_IDLE_MS = 60000;
const POSSIBLE_CONVERSATION_END_EVENTS = [
"conversation-ended",
"conversation_ended",
"conversationEnded",
"session-ended",
"session_ended",
"sessionEnded",
"call-ended",
"call_ended",
"callEnded",
"connection-closed",
"connection_closed",
"connectionClosed",
"CONNECTION_CLOSED"
];

let started = false;
let ws = null;
let micStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silenceCommitSent = false;
let lastSpeechTs = 0;
let lastCommitTs = 0;
let intentionalStop = false;
let reconnectAttempts = 0;
let lastServerError = "";
let lastCommittedText = "";
let lastCommittedAt = 0;
let idleStopTimer = null;

function clearIdleStopTimer() {
if (idleStopTimer) {
clearTimeout(idleStopTimer);
idleStopTimer = null;
}
}

function scheduleIdleAutoStop() {
clearIdleStopTimer();

if (!started || intentionalStop) {
return;
}

idleStopTimer = setTimeout(() => {
if (!started || intentionalStop) {
return;
}
stopTranscription("Stopped after conversation inactivity.");
}, AUTO_STOP_AFTER_IDLE_MS);
}

function setStatus(text, className) {
transcriptStatus.textContent = text;
transcriptPanel.classList.remove("status-idle", "status-live", "status-fallback");
transcriptPanel.classList.add(className);
}

function setActiveLine(text) {
const clean = String(text || "").trim();
transcriptActive.textContent = clean ? "User: " + clean : "";
}

function setLatestCommittedLine(text) {
const clean = String(text || "").trim();
if (!clean) {
return;
}

transcriptHistory.innerHTML = "";
const row = document.createElement("div");
row.className = "transcript-line";
row.textContent = clean;
transcriptHistory.appendChild(row);
}

function downsampleTo16k(floatBuffer, inputSampleRate) {
if (inputSampleRate === SAMPLE_RATE) {
return floatBuffer;
}

const ratio = inputSampleRate / SAMPLE_RATE;
const newLength = Math.round(floatBuffer.length / ratio);
const result = new Float32Array(newLength);
let offsetResult = 0;
let offsetBuffer = 0;

while (offsetResult < result.length) {
const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
let accum = 0;
let count = 0;
for (let i = offsetBuffer; i < nextOffsetBuffer && i < floatBuffer.length; i += 1) {
accum += floatBuffer[i];
count += 1;
}
result[offsetResult] = count > 0 ? accum / count : 0;
offsetResult += 1;
offsetBuffer = nextOffsetBuffer;
}

return result;
}

function floatTo16BitPCM(floatBuffer) {
const output = new Int16Array(floatBuffer.length);
for (let i = 0; i < floatBuffer.length; i += 1) {
const s = Math.max(-1, Math.min(1, floatBuffer[i]));
output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
}
return output;
}

function int16ToBase64(int16Buffer) {
const bytes = new Uint8Array(int16Buffer.buffer);
const chunk = 0x8000;
let binary = "";

for (let i = 0; i < bytes.length; i += chunk) {
const sub = bytes.subarray(i, i + chunk);
binary += String.fromCharCode.apply(null, sub);
}

return btoa(binary);
}

function calculateRms(floatBuffer) {
let sum = 0;
for (let i = 0; i < floatBuffer.length; i += 1) {
sum += floatBuffer[i] * floatBuffer[i];
}
return Math.sqrt(sum / floatBuffer.length);
}

function sendAudioChunk(base64Chunk) {
if (!ws || ws.readyState !== WebSocket.OPEN) {
return;
}

const payload = {
message_type: "input_audio_chunk",
audio_base_64: base64Chunk,
sample_rate: SAMPLE_RATE
};

ws.send(JSON.stringify(payload));
}

function handleRealtimeMessage(raw) {
let message;
try {
message = JSON.parse(raw);
} catch (_error) {
return;
}

const type = message.message_type || message.type || "";
const text = typeof message.text === "string" ? message.text.trim() : "";

if (type === "session_started") {
setStatus("Listening...", "status-live");
scheduleIdleAutoStop();
return;
}

if (type === "partial_transcript") {
setActiveLine("");
scheduleIdleAutoStop();
return;
}

if (type === "committed_transcript" || type === "committed_transcript_with_timestamps") {
if (text) {
const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
const now = Date.now();
const isDuplicate = normalized && normalized === lastCommittedText && now - lastCommittedAt < 3000;
if (!isDuplicate) {
lastCommittedText = normalized;
lastCommittedAt = now;
setLatestCommittedLine("User: " + text);
}
}
setActiveLine("");
scheduleIdleAutoStop();
return;
}

if (type === "error") {
const detail = message.error || message.message || "Realtime error";
lastServerError = String(detail);
setStatus("Transcription service error.", "status-fallback");
return;
}

if (type.toLowerCase().includes("error")) {
const detail = message.error || message.message || message.detail || JSON.stringify(message);
lastServerError = String(detail);
setStatus("Transcription service error.", "status-fallback");
}
}

async function getSingleUseToken() {
if (!ELEVENLABS_API_KEY || ELEVENLABS_API_KEY === ELEVENLABS_API_KEY_PLACEHOLDER) {
throw new Error("Set API key in transcription script.");
}

const response = await fetch(ELEVENLABS_TOKEN_ENDPOINT, {
method: "POST",
headers: {
"xi-api-key": ELEVENLABS_API_KEY
}
});

if (!response.ok) {
let errorText = "";
try {
errorText = await response.text();
} catch (_error) {
errorText = "";
}
console.error("Token request failed", response.status, errorText);
throw new Error("Token request failed (" + response.status + ").");
}

const body = await response.json();
if (!body.token) {
throw new Error("Token response missing token");
}

return body.token;
}

async function connectRealtime() {
setStatus("Connecting live transcript...", "status-idle");

const token = await getSingleUseToken();
const wsUrl = WS_BASE_URL
+ "?model_id=" + encodeURIComponent(MODEL_ID)
+ "&token=" + encodeURIComponent(token)
+ "&include_timestamps=true"
+ "&include_language_detection=true"
+ "&commit_strategy=vad";

ws = new WebSocket(wsUrl);

ws.onopen = () => {
reconnectAttempts = 0;
setStatus("Connected. Speak now.", "status-live");
scheduleIdleAutoStop();
};

ws.onmessage = (event) => {
handleRealtimeMessage(event.data);
};

ws.onerror = () => {
setStatus("Connection issue. Tap avatar to retry.", "status-fallback");
};

ws.onclose = (event) => {
const code = event && typeof event.code === "number" ? event.code : 0;
const reason = event && event.reason ? event.reason : "";
const detail = lastServerError ? " " + lastServerError : "";

ws = null;

if (intentionalStop) {
return;
}

started = false;
setStatus("Connection closed (code " + code + ").", "status-fallback");
if (detail || reason) {
console.warn("Transcript connection closed:", code, reason, detail);
}

if (micStream && reconnectAttempts < 2) {
reconnectAttempts += 1;
setTimeout(() => {
if (!started && micStream) {
startTranscription();
}
}, 900);
}
};
}

async function startMicrophoneStreaming() {
if (micStream && audioContext && processorNode) {
return;
}

micStream = await navigator.mediaDevices.getUserMedia({
audio: {
echoCancellation: true,
noiseSuppression: true,
autoGainControl: true
}
});

audioContext = new (window.AudioContext || window.webkitAudioContext)();
sourceNode = audioContext.createMediaStreamSource(micStream);
processorNode = audioContext.createScriptProcessor(4096, 1, 1);

const silenceGain = audioContext.createGain();
silenceGain.gain.value = 0;

sourceNode.connect(processorNode);
processorNode.connect(silenceGain);
silenceGain.connect(audioContext.destination);

processorNode.onaudioprocess = (event) => {
if (!ws || ws.readyState !== WebSocket.OPEN) {
return;
}

const input = event.inputBuffer.getChannelData(0);
const downsampled = downsampleTo16k(input, audioContext.sampleRate);
const pcm16 = floatTo16BitPCM(downsampled);
const base64Chunk = int16ToBase64(pcm16);

const rms = calculateRms(downsampled);
const now = Date.now();
const isSpeech = rms > 0.012;
if (isSpeech) {
lastSpeechTs = now;
silenceCommitSent = false;
scheduleIdleAutoStop();
}
if (!isSpeech && lastSpeechTs > 0 && !silenceCommitSent && now - lastSpeechTs > 650) {
silenceCommitSent = true;
lastCommitTs = now;
}

sendAudioChunk(base64Chunk);
};
}

async function startTranscription() {
if (started) {
return;
}
started = true;
intentionalStop = false;
lastServerError = "";
scheduleIdleAutoStop();

try {
await startMicrophoneStreaming();
await connectRealtime();
} catch (error) {
started = false;
clearIdleStopTimer();
const message = error && error.message ? error.message : "Unable to start transcription";
setStatus(message, "status-fallback");
}
}

function stopTranscription(idleMessage) {
intentionalStop = true;
clearIdleStopTimer();

if (processorNode) {
processorNode.disconnect();
processorNode.onaudioprocess = null;
processorNode = null;
}

if (sourceNode) {
sourceNode.disconnect();
sourceNode = null;
}

if (audioContext) {
audioContext.close();
audioContext = null;
}

if (micStream) {
micStream.getTracks().forEach((track) => track.stop());
micStream = null;
}

if (ws && ws.readyState === WebSocket.OPEN) {
ws.close();
}
ws = null;
started = false;
setStatus(idleMessage || "Stopped.", "status-idle");
}

function bindConversationEndEvents() {
const agentElement = document.querySelector("anam-agent");
if (!agentElement) {
return;
}

POSSIBLE_CONVERSATION_END_EVENTS.forEach((eventName) => {
agentElement.addEventListener(eventName, () => {
if (started) {
stopTranscription("Conversation ended. Transcript stopped.");
}
});
});
}

anamContainer.addEventListener("click", startTranscription);
anamContainer.addEventListener("keydown", startTranscription);
window.addEventListener("beforeunload", () => stopTranscription());
document.addEventListener("visibilitychange", () => {
if (document.hidden && started) {
stopTranscription();
}
});
bindConversationEndEvents();

setStatus("Tap avatar area to start live captions.", "status-idle");
})();
