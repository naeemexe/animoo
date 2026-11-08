// Stream an agent run from the server (server-sent events), step by step.
//
//   const run = streamAgent('test', 'Which is closer…', { onStep, onDone, onError });
//   run.close();
//
// Each step is {agent, kind: thought|call|result|final|error, text, ms, data?},
// the same shape the Movie page's agent log draws, so a page can pass it
// straight to its log(). onDone gets {steps, seconds, llm_calls, llm_seconds,
// backend, model}.
import { API_BASE } from './api.js';

export function streamAgent(name, task, { onStep = () => {}, onDone = () => {}, onError = () => {} } = {}) {
  const url = `${API_BASE}/api/agents/${encodeURIComponent(name)}/run?task=${encodeURIComponent(task)}`;
  const es = new EventSource(url);
  let finished = false;
  es.onmessage = (e) => onStep(JSON.parse(e.data));
  es.addEventListener('done', (e) => {
    finished = true;
    es.close();
    onDone(JSON.parse(e.data));
  });
  es.onerror = () => {
    // EventSource reconnects on its own; a run is one-shot, so stop instead.
    es.close();
    if (!finished) onError(new Error('the agent stream closed early'));
  };
  return { close: () => es.close() };
}

// The agent-log row the Movie page uses (web/js/movie/page.js), for other pages.
export function logStep(list, { agent, kind, text, ms }) {
  const li = document.createElement('li');
  const err = kind === 'error';
  li.className = `step ${kind}${err ? ' err' : ''}`;
  li.innerHTML = `<span class="agent ${agent}">${agent}</span><span class="kind"></span><span class="text"></span>`;
  li.querySelector('.kind').textContent = ms ? `${kind} · ${(ms / 1000).toFixed(1)} s` : kind;
  li.querySelector('.text').textContent = text;
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
  return li;
}
