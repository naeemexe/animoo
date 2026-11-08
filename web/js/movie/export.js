// Record the canvas to WebM while the film plays once, in real time.
const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
const AV_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];

// hooks: start() begins playback, done() says it has ended, progress() is 0–1.
// audio: a MediaStream (the scene sound, task 32) mixed in as the file's audio track.
// → { blob, url, name, type, seconds, audio }
export async function recordWebM(canvas, { start, done, progress, onProgress = () => {}, fps = 30, bitrate = 8e6, audio = null }) {
  if (!window.MediaRecorder) throw new Error('this browser has no MediaRecorder');
  const tracks = audio?.getAudioTracks() ?? [];
  const type = (tracks.length && AV_TYPES.find((t) => MediaRecorder.isTypeSupported(t))) || TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('this browser cannot record WebM');
  const video = canvas.captureStream(fps);
  const withAudio = tracks.length > 0 && type.includes('opus');
  const stream = new MediaStream([...video.getVideoTracks(), ...(withAudio ? tracks : [])]);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitrate, audioBitsPerSecond: 128e3 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve, reject) => {
    rec.onstop = resolve;
    rec.onerror = (e) => reject(e.error ?? new Error('recording failed'));
  });
  const t0 = performance.now();
  rec.start(500);
  start();
  await new Promise((resolve) => {
    const tick = () => {
      onProgress(progress());
      if (done()) resolve(); else requestAnimationFrame(tick);
    };
    tick();
  });
  // A few more frames so the last pose is in the file.
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await stopped;
  video.getTracks().forEach((t) => t.stop()); // the audio track belongs to the scene sound: it stays live
  const blob = new Blob(chunks, { type: 'video/webm' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return { blob, url: URL.createObjectURL(blob), name: `animo-movie-${stamp}.webm`, type, seconds: (performance.now() - t0) / 1000, audio: withAudio };
}
