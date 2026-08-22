// Pipeflow voice-chat client: mic → PCM over the WebSocket, and a small
// playback queue for the agent's audio. The server sends JSON control
// messages (turn/delta/done/error) and binary audio frames — one mp3 per
// synthesized sentence, decoded at its real sample rate on playback.

const logEl = document.getElementById("log");
const textInput = document.getElementById("text");
const sendBtn = document.getElementById("send");
const micBtn = document.getElementById("mic");
const statusEl = document.getElementById("status");
const floorSlider = document.getElementById("floor");
const floorValue = document.getElementById("floor-value");
const clipEnergyEl = document.getElementById("clip-energy");

const ws = new WebSocket(`ws://${location.host}/ws`);
ws.binaryType = "arraybuffer";

// The socket is still CONNECTING for a moment after the page loads — send()
// throws on it. Drop early messages instead; the server resyncs the floor on
// connect, and nothing user-triggerable happens before the handshake anyway.
function sendJson(obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// The STT clip-energy floor (minClipRms) is tunable live: dragging the
// slider updates the server, and the server broadcasts every clip's measured
// RMS so you can see where speech vs. artifacts land and set the floor where
// they separate.
floorSlider.addEventListener("input", () => {
  const value = Number(floorSlider.value);
  floorValue.textContent = value.toFixed(3);
  sendJson({ type: "minClipRms", value });
});

let agentLine = null; // the live agent message element being streamed into
// User-side truncation: an utterance ends (clip sent), and if a *new*
// utterance starts before that clip's turn comes back from STT, the turn was
// a slice of continued speech — its line gets a "…".
let utterancePending = false;
let cutUtterance = false;

function addLine(className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

/**
 * Mark the in-flight agent line as cut short (barge-in / interrupt) and
 * close it. No-op when the agent already finished (`done` cleared the line)
 * or never started speaking.
 */
function truncateAgentLine() {
  if (agentLine) {
    agentLine.textContent += "…";
    agentLine = null;
  }
}

ws.onmessage = (event) => {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data);
    if (msg.type === "turn") {
      // A new user turn finalizes the previous agent line and ends its audio.
      // If the agent was still responding (no `done` yet), its line was cut
      // short by the barge-in — mark it truncated.
      truncateAgentLine();
      stopPlayback();
      // If the user kept talking after this clip, the turn is a slice of
      // their continued speech — mark it truncated too.
      const text = cutUtterance ? `${msg.text}…` : msg.text;
      cutUtterance = false;
      utterancePending = false;
      addLine("user", `You: ${text}`);
    } else if (msg.type === "minClipRms") {
      // The server's current floor (on connect, so the slider starts in sync).
      floorSlider.value = String(msg.value);
      floorValue.textContent = Number(msg.value).toFixed(3);
    } else if (msg.type === "clip-energy") {
      // Live feedback for tuning the floor: where did the last clip land?
      clipEnergyEl.textContent = msg.transcribed
        ? `last clip rms=${msg.rms.toFixed(3)} — transcribed`
        : `last clip rms=${msg.rms.toFixed(3)} — skipped (below floor)`;
    } else if (msg.type === "delta") {
      if (!agentLine) agentLine = addLine("agent", "");
      agentLine.textContent += msg.text;
      logEl.scrollTop = logEl.scrollHeight;
    } else if (msg.type === "done") {
      agentLine = null;
    } else if (msg.type === "interrupt") {
      // The server aborted the generation/synthesis (barge-in, stop). Cut the
      // playback and, if a partial line is open, mark it truncated.
      truncateAgentLine();
      stopPlayback();
    } else if (msg.type === "error") {
      addLine("error", `⚠ ${msg.message}`);
    }
    return;
  }
  // Binary frame = a TTS audio chunk.
  queueAudio(new Uint8Array(event.data));
};

// ---------------------------------------------------------------------------
// Audio output: each binary frame is one synthesized sentence (mp3). Frames
// are decoded with `decodeAudioData` — which honors the provider's real
// sample rate, whatever it is — and played in order, one after another.
// ---------------------------------------------------------------------------

let audioCtx = null;
const decodeQueue = [];
let decoding = false;
let currentSource = null; // the buffer currently playing (for barge-in)
let playEpoch = 0; // bumped on stop so in-flight decodes can be dropped

// A short pause between synthesized sentences so multi-sentence replies
// don't sound run-on. The gap only lands *between* frames — never before the
// first, never after the last — and an interrupt drops the queue, so it can't
// delay a barge-in.
const SENTENCE_GAP_MS = 180;

function ensureAudio() {
  // Created/resumed inside a user gesture so autoplay is allowed. The 16 kHz
  // context rate is for mic capture; decoded playback is rate-independent.
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 16000 });
  if (audioCtx.state === "suspended") void audioCtx.resume();
}

/**
 * Cut the agent's audio immediately: stop the currently playing sentence and
 * drop every queued one. Called on barge-in (the user starts speaking), on a
 * new user turn, and on the server's `interrupt` message.
 */
function stopPlayback() {
  playEpoch++;
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // Already ended.
    }
    currentSource = null;
  }
  decodeQueue.length = 0;
}

function queueAudio(bytes) {
  if (!audioCtx) return; // no playback context yet (user hasn't clicked)
  decodeQueue.push(bytes);
  if (!decoding) void drain();
}

async function drain() {
  decoding = true;
  while (decodeQueue.length > 0) {
    const bytes = decodeQueue.shift();
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    try {
      const epoch = playEpoch;
      const buffer = await audioCtx.decodeAudioData(arrayBuffer);
      if (epoch !== playEpoch) continue; // stopped while decoding
      await playBuffer(buffer);
      if (decodeQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, SENTENCE_GAP_MS));
      }
    } catch (error) {
      addLine("error", `⚠ Audio decode failed: ${error.message}`);
    }
  }
  decoding = false;
}

function playBuffer(buffer) {
  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    currentSource = src;
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.onended = () => {
      if (currentSource === src) currentSource = null;
      resolve();
    };
    src.start();
  });
}

// ---------------------------------------------------------------------------
// Audio input: mic → 16 kHz → Int16 PCM, with a tiny VAD so silence isn't
// sent (the server's STT segments utterances on the silence gaps).
// ---------------------------------------------------------------------------

let processor = null;
let micStream = null;
let micActive = false;

micBtn.addEventListener("click", async () => {
  if (micActive) {
    processor?.disconnect();
    micStream?.getTracks().forEach((track) => track.stop());
    micActive = false;
    micBtn.textContent = "🎤 Start mic";
    statusEl.textContent = "";
    return;
  }
  try {
    ensureAudio();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // The speaker's audio feeds back into the mic; without echo
        // cancellation whisper "hears" the agent and hallucinates repeats
        // ("Thank you. Thank you."). Noise suppression keeps pops and room
        // tone from becoming transcribed "stage directions" (*Dramatic
        // music*).
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const source = audioCtx.createMediaStreamSource(micStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination); // keep the processor alive

    // VAD with hysteresis: an utterance needs a short streak of voiced
    // buffers to start (so pops, chewing, and mic taps don't become turns)
    // and two consecutive silent buffers to end. The lead-in is sent so the
    // start of the first word isn't clipped. The clip ends as cleanly as
    // possible — one silent tail buffer, nothing more — and the server's STT
    // segments utterances on the silence gap.
    //
    // Barge-in fires only on *confirmed* speech: playback cuts and audio is
    // sent together, once the voiced streak reaches `startCount`. A tap or
    // pop is a single-buffer transient and never reaches the streak, so it
    // can't interrupt the agent.
    const threshold = 0.03;
    const startCount = 3; // voiced 256ms buffers needed to confirm an utterance
    let talking = false;
    let voicedStreak = 0;
    let silentStreak = 0;
    let leadIn = [];
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const voiced = Math.sqrt(sum / input.length) >= threshold;

      if (!talking) {
        if (voiced) {
          // The first buffer can be a transient (tap, pop) — don't react to
          // it yet. Only a *sustained* streak proves the user is speaking.
          leadIn.push(input);
          if (leadIn.length > startCount - 1) leadIn.shift();
          if (++voicedStreak >= startCount) {
            talking = true;
            silentStreak = 0;
            // A new utterance while the previous clip's turn is still
            // pending means the previous one was cut short by more speech.
            if (utterancePending) cutUtterance = true;
            // Confirmed speech — only now cut the agent and send.
            stopPlayback();
            for (const lead of leadIn) sendPcm(lead);
            leadIn = [];
          }
        } else {
          voicedStreak = 0;
        }
        if (!talking) return;
      }

      // Talking: send voiced buffers immediately. A single silent buffer is
      // sent as a tail so the ends of words aren't clipped; the utterance then
      // ends on the next silent buffer. Trailing silence in the clip is what
      // whisper "fills in" with hallucinated words ("Thank you.", …), so the
      // clip is cut as cleanly as possible — the server's STT segments on the
      // silence gap itself.
      if (voiced) {
        silentStreak = 0;
        sendPcm(input);
      } else if (++silentStreak >= 2) {
        talking = false;
        voicedStreak = 0;
        silentStreak = 0;
        // The clip is complete; its turn comes back after transcription.
        utterancePending = true;
      } else {
        sendPcm(input);
      }
    };
    micActive = true;
    micBtn.textContent = "🎤 Stop mic";
    statusEl.textContent = "Listening… (speak; silence segments each turn)";
  } catch (error) {
    addLine("error", `⚠ Mic failed: ${error.message}`);
  }
});

function sendPcm(float) {
  const pcm = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

function sendText() {
  const text = textInput.value.trim();
  if (!text) return;
  ensureAudio();
  sendJson({ type: "text", text });
  textInput.value = "";
}

sendBtn.addEventListener("click", sendText);
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendText();
});
