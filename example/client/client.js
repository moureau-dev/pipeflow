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
let pumping = false; // a pump loop is draining the queue
let currentSource = null; // the buffer currently playing (for barge-in)
let playEpoch = 0; // bumped on stop so in-flight decodes can be dropped

// A short pause between synthesized sentences so multi-sentence replies
// don't sound run-on. The gap only lands *between* frames — never before the
// first, never after the last — and an interrupt drops the queue, so it can't
// delay a barge-in.
const SENTENCE_GAP_MS = 180;
// Bounds that keep one wedged frame from stalling the whole queue. A decode
// or a playing source normally settles in well under these; when one never
// does (suspended context, missed `onended`, decode hiccup) the frame is
// skipped so the next one can play instead of the queue waiting forever.
const DECODE_TIMEOUT_MS = 10_000;

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

/** Resolve `promise` if it settles in time, otherwise reject. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function queueAudio(bytes) {
  if (!audioCtx) return; // no playback context yet (user hasn't clicked)
  if (audioCtx.state === "closed") return;
  // A backgrounded tab or an audio-device change can leave the context
  // suspended. A suspended context never advances a playing source, so its
  // `onended` never fires and the old single-flight drain stalled on that
  // frame forever — the reply stopped mid-way and only a barge-in (which
  // stops the source) unstuck it. Resume eagerly and let pump() heal any
  // stall instead of waiting for the next user input.
  if (audioCtx.state === "suspended") void audioCtx.resume();
  decodeQueue.push(bytes);
  if (!pumping) void pump();
}

async function pump() {
  pumping = true;
  try {
    while (decodeQueue.length > 0) {
      const bytes = decodeQueue.shift();
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      const epoch = playEpoch;

      let buffer;
      try {
        if (audioCtx.state === "suspended") {
          await audioCtx.resume().catch(() => {});
        }
        buffer = await withTimeout(
          audioCtx.decodeAudioData(arrayBuffer),
          DECODE_TIMEOUT_MS,
        );
      } catch (error) {
        if (playEpoch !== epoch) continue; // stopped while decoding — drop it
        addLine("error", `⚠ Audio decode failed: ${error.message}`);
        continue;
      }
      if (playEpoch !== epoch) continue; // stopped while decoding — drop it

      await playBuffer(buffer);
      // The pause between sentences is skippable: it never lands before the
      // first frame, after the last, or across a stop.
      if (decodeQueue.length > 0 && playEpoch === epoch) {
        await new Promise((resolve) => setTimeout(resolve, SENTENCE_GAP_MS));
      }
    }
  } finally {
    pumping = false;
    // Frames queued while the loop was winding down still need a pump.
    if (decodeQueue.length > 0) void pump();
  }
}

function playBuffer(buffer) {
  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    currentSource = src;
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    let watchdog = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (currentSource === src) currentSource = null;
      resolve();
    };
    src.onended = finish;
    src.start();
    // Watchdog: if `onended` never fires (suspended context, missed event),
    // stop the source and move on so the queue can't stall on this frame.
    watchdog = setTimeout(() => {
      try {
        src.stop();
      } catch {
        // Already ended.
      }
      finish();
    }, Math.max(5_000, buffer.duration * 1000 + 3_000));
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

    // VAD with a frame-level state machine (~32ms frames). The previous
    // per-buffer logic decided on whole 256ms blocks, which is what produced
    // the artifacts:
    //   - it needed 3 *consecutive voiced blocks* (~770ms) to start, so short
    //     words ("sim") never opened a clip and the user had to repeat them;
    //   - it dropped the first voiced block, so words whose onset landed there
    //     lost their first letter/syllable;
    //   - it sent the confirming block twice, so whisper heard duplicated
    //     audio and echoed words back;
    //   - clips started abruptly at speech (no lead-in silence) and ended
    //     after one silent block, which is exactly when whisper loop-
    //     hallucinates ("to the back, to the back…") and pads word repeats.
    //
    // Now idle frames accumulate in a bounded pre-roll. When a real speech
    // burst is confirmed the clip is sent *from the pre-roll*, so whisper
    // always gets ~160ms of leading silence before the first voiced frame and
    // nothing at the onset is dropped. The utterance runs until ~450ms of
    // trailing silence, which is sent as the clip's tail so the last word
    // isn't cut off. Barge-in still fires only on *confirmed* speech: a tap
    // or pop is a frame or two and never reaches the burst threshold, so it
    // can't interrupt the agent.
    const FRAME_MS = 32;
    const frameLen = Math.round((audioCtx.sampleRate / 1000) * FRAME_MS);
    const VOICE_RMS = 0.02; // a frame at/above this counts as voiced
    const STRONG_RMS = 0.07; // loud enough to be unmistakably speech
    const CONFIRM_VOICED = 4; // voiced frames within the window below…
    const CONFIRM_WINDOW = 6; // …~192ms of recent frames confirm an utterance
    const TAIL_SILENCE_FRAMES = 14; // ~450ms silent run ends the utterance
    const LEAD_SILENCE_FRAMES = 5; // ~160ms of pre-roll before the burst
    const PRE_MAX_FRAMES = 40; // idle pre-roll cap (~1.3s)
    const BURST_GAP_FRAMES = 2; // silent frames tolerated inside a burst

    let talking = false;
    let silentRun = 0; // consecutive silent frames while talking
    let pre = []; // idle pre-roll frames { data, voiced, strong }, newest last
    let leftover = new Float32Array(0); // samples carried between processor blocks

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);

      // The block boundary rarely lines up with the frame grid; stitch any
      // remainder from the previous block onto the front of this one so no
      // samples are lost between frames.
      const samples = new Float32Array(leftover.length + input.length);
      samples.set(leftover);
      samples.set(input, leftover.length);

      const out = []; // Float32Array frames to send once this block is processed
      let offset = 0;
      while (offset + frameLen <= samples.length) {
        const data = samples.slice(offset, offset + frameLen);
        offset += frameLen;

        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const level = Math.sqrt(sum / data.length);
        const voiced = level >= VOICE_RMS;
        const strong = level >= STRONG_RMS;

        if (!talking) {
          // Idle: hold recent frames so the clip can start *before* the burst.
          pre.push({ data, voiced, strong });
          if (pre.length > PRE_MAX_FRAMES) pre.splice(0, pre.length - PRE_MAX_FRAMES);

          // Confirm on a speech burst: CONFIRM_VOICED voiced frames within the
          // last CONFIRM_WINDOW (~192ms) — a short word qualifies — or a loud
          // burst (2 strong frames with real voiced content). A tap/pop is one
          // or two frames and never reaches either.
          const window = pre.slice(-CONFIRM_WINDOW);
          let voicedCount = 0;
          let strongCount = 0;
          for (const frame of window) {
            if (frame.voiced) voicedCount++;
            if (frame.strong) strongCount++;
          }
          const burst =
            window.length >= CONFIRM_VOICED &&
            (voicedCount >= CONFIRM_VOICED || (strongCount >= 2 && voicedCount >= 3));

          if (burst) {
            // A new utterance while the previous clip's turn is still pending
            // means the previous one was cut short by more speech.
            if (utterancePending) cutUtterance = true;
            // Confirmed speech — only now cut the agent.
            stopPlayback();
            talking = true;
            silentRun = 0;

            // Walk back to where the burst began (tolerating a short dip) and
            // send from LEAD_SILENCE_FRAMES before it, so whisper hears real
            // lead-in silence instead of an abrupt mid-word start.
            let i = pre.length - 1;
            let gap = 0;
            while (i >= 0) {
              if (pre[i].voiced || pre[i].strong) gap = 0;
              else gap++;
              if (gap > BURST_GAP_FRAMES) break;
              i--;
            }
            let start = Math.max(0, i + 1 - LEAD_SILENCE_FRAMES);
            for (; start < pre.length; start++) out.push(pre[start].data);
            pre = [];
          }
          continue;
        }

        // Talking: send speech immediately. Silent frames are still sent as a
        // tail so the ends of words aren't clipped; once the silent run passes
        // TAIL_SILENCE_FRAMES the utterance is complete.
        if (voiced) {
          silentRun = 0;
          out.push(data);
        } else if (silentRun < TAIL_SILENCE_FRAMES) {
          out.push(data);
          silentRun++;
        } else {
          talking = false;
          silentRun = 0;
          pre = [];
          // The clip is complete; its turn comes back after transcription.
          utterancePending = true;
        }
      }

      leftover = samples.slice(offset);
      if (out.length === 0) return;

      // Convert the block's frames to one linear16 PCM message (the server's
      // STT buffers until silence, so message boundaries don't matter).
      let total = 0;
      for (const frame of out) total += frame.length;
      const pcm = new Int16Array(total);
      let p = 0;
      for (const frame of out) {
        for (let i = 0; i < frame.length; i++) {
          const s = Math.max(-1, Math.min(1, frame[i]));
          pcm[p++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
    };
    micActive = true;
    micBtn.textContent = "🎤 Stop mic";
    statusEl.textContent = "Listening… (speak; silence segments each turn)";
  } catch (error) {
    addLine("error", `⚠ Mic failed: ${error.message}`);
  }
});

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
