// The character's voice: ElevenLabs (server/elevenlabs.py speech(), cached),
// else the browser's speechSynthesis with the best installed English voice.
// Text is spoken one sentence at a time (Chrome cuts long
// utterances off, and the page wants to know when the first sentence ends).
// With no speech engine or no voices, it times the sentences from their
// length instead, so the talking gesture still plays.

const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|pipe organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|kathy|grandma|grandpa|rocko|shelley|eddy|flo|reed|sandy)\b/i;
const QUALITY = /\b(premium|enhanced|natural|neural|wavenet|online)\b/i;
// Clear, warm male voices (the chat character is a boy) that ship with macOS,
// Windows, ChromeOS and Android.
const LIKED = /\b(aaron|alex|daniel|evan|nathan|tom|oliver|arthur|rishi|google uk english male|microsoft (guy|david|mark|ryan|andrew|brian))\b/i;
const FEMALE = /\b(female|ava|zoe|samantha|allison|susan|serena|karen|moira|tessa|aria|jenny|libby|sonia|victoria|fiona|kate|zira|google us english)\b/i;

// The voice menu's entry for the ElevenLabs voice (the server picks the voice id).
export const ELEVEN = 'ElevenLabs · Liam';

export function scoreVoice(v) {
  let s = 0;
  if (!/^en\b|^en[-_]/i.test(v.lang)) return -100;
  if (/^en[-_]US/i.test(v.lang)) s += 3;
  else if (/^en[-_](GB|AU|IE|CA)/i.test(v.lang)) s += 2;
  if (QUALITY.test(v.name)) s += 8;
  if (LIKED.test(v.name)) s += 4;
  if (/google/i.test(v.name)) s += 2;
  if (NOVELTY.test(v.name)) s -= 30;
  if (FEMALE.test(v.name)) s -= 6;
  return s;
}

export function splitSentences(text) {
  return (text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createVoice({ onVoices = () => {} } = {}) {
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  const state = { voice: null, voices: [], speaking: false, level: 0, eleven: true, elevenFailed: false, audio: null };
  let run = 0; // bumped by stop(), so an old speak() loop gives up
  let chosenByUser = false;

  function refresh() {
    if (!synth) { onVoices(state); return; }
    state.voices = synth.getVoices().filter((v) => scoreVoice(v) > -100)
      .sort((a, b) => scoreVoice(b) - scoreVoice(a) || a.name.localeCompare(b.name));
    if (!chosenByUser || !state.voices.includes(state.voice)) state.voice = state.voices[0] ?? null;
    onVoices(state);
  }
  if (synth) {
    refresh();
    synth.addEventListener?.('voiceschanged', refresh);
  }

  function setVoice(name) {
    state.eleven = name === ELEVEN;
    if (state.eleven) return;
    state.voice = state.voices.find((v) => v.name === name) ?? state.voice;
    chosenByUser = true;
  }

  // ElevenLabs (through POST /api/chat/speech, cached in library/audio/): one
  // mp3 per sentence. Any failure turns it off for the session and the browser
  // voice takes over.
  const urls = new Map(); // sentence → Promise<url | null>
  function elevenUrl(sentence) {
    if (!urls.has(sentence)) {
      urls.set(sentence, fetch('/api/chat/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: sentence }),
      }).then((r) => (r.ok ? r.json() : r.text().then((t) => { throw new Error(`${r.status} ${t.slice(0, 120)}`); })))
        .then((j) => j.url)
        .catch((err) => {
          console.warn('ElevenLabs voice failed, using the browser voice:', err.message);
          state.eleven = false;
          state.elevenFailed = true;
          urls.delete(sentence);
          onVoices(state);
          return null;
        }));
    }
    return urls.get(sentence);
  }

  async function playOne(sentence, id) {
    const url = await elevenUrl(sentence);
    if (!url) return false; // fall back for this sentence
    if (id !== run) return true;
    return new Promise((resolve) => {
      const audio = new Audio(url);
      state.audio = audio;
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); if (state.audio === audio) state.audio = null; resolve(true); } };
      const timer = setTimeout(finish, 30000);
      audio.onended = finish;
      audio.onerror = () => { console.warn('speech audio failed to play'); finish(); };
      audio.onpause = finish; // stop()
      audio.play().catch((err) => { console.warn('speech audio:', err.message); finish(); });
    });
  }

  // One sentence: resolves when it has been spoken (or after a timeout, since
  // Chrome sometimes never fires `end`).
  function sayOne(sentence, id) {
    const estimate = 600 + sentence.split(/\s+/).length * 380;
    if (!synth || !state.voice) return sleep(estimate);
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(sentence);
      u.voice = state.voice;
      u.lang = state.voice.lang;
      u.rate = 1.0;
      u.pitch = 1.05;
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, estimate * 2.5 + 2000);
      u.onend = finish;
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('speech:', e.error); finish(); };
      state.utterance = u; // keep a reference, or Chrome may drop the events
      if (id === run) synth.speak(u);
      else finish();
    });
  }

  // Speak `text`. `onSentence(i)` is called after sentence i ends.
  async function speak(text, { onSentence = () => {} } = {}) {
    stop();
    const id = run;
    const sentences = splitSentences(text);
    if (state.eleven) sentences.forEach(elevenUrl); // ask for every sentence now, play them in turn
    state.speaking = true;
    try {
      for (let i = 0; i < sentences.length && id === run; i++) {
        if (!(state.eleven && await playOne(sentences[i], id))) await sayOne(sentences[i], id);
        if (id === run) onSentence(i, sentences.length);
      }
    } finally {
      if (id === run) state.speaking = false;
    }
  }

  function stop() {
    run++;
    state.speaking = false;
    synth?.cancel();
    state.audio?.pause();
    state.audio = null;
  }

  return { state, speak, stop, setVoice, refresh, get available() { return !!synth || state.eleven; } };
}
