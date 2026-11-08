// Record the canvas to WebM while the film plays once, in real time.
const TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

// hooks: start() begins playback, done() says it has ended, progress() is 0–1.
// → { blob, url, name, type, seconds }
export async function recordWebM(canvas, { start, done, progress, onProgress = () => {}, fps = 30, bitrate = 8e6 }) {
  if (!window.MediaRecorder) throw new Error('this browser has no MediaRecorder');
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('this browser cannot record WebM');
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitrate });
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
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'video/webm' });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  return { blob, url: URL.createObjectURL(blob), name: `animo-movie-${stamp}.webm`, type, seconds: (performance.now() - t0) / 1000 };
}
