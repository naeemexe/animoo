// /agents.html: run a server agent and watch its steps stream in.
import { getHealth } from './api.js';
import { streamAgent, logStep } from './agent-stream.js';

const params = new URLSearchParams(location.search);
const AGENT = params.get('agent') ?? 'test';
const $ = (id) => document.getElementById(id);
$('task').value = params.get('task')
  ?? 'Which is closer to the well, the windmill or the dock? Give both distances.';

getHealth().then((h) => {
  const l = h.config?.llm;
  $('llm').textContent = l ? `${l.backend} · ${l.model}` : 'no backend';
  $('llm').classList.add(l?.ready ? 'ok' : 'warn');
}).catch(() => { $('llm').textContent = 'no backend'; $('llm').classList.add('bad'); });

let current = null;
function go() {
  current?.close();
  $('log').innerHTML = '';
  $('summary').textContent = 'running…';
  $('go').disabled = true;
  const t0 = performance.now();
  current = streamAgent(AGENT, $('task').value, {
    onStep: (step) => logStep($('log'), step),
    onDone: (s) => {
      $('go').disabled = false;
      $('summary').textContent = `${s.steps} steps · ${s.seconds} s · ${s.llm_calls} Nemotron calls `
        + `(${s.llm_seconds.map((x) => `${x} s`).join(', ')}) · ${s.backend} ${s.model}`;
      window.animo.lastRun = { ...s, clientSeconds: (performance.now() - t0) / 1000 };
    },
    onError: (err) => {
      $('go').disabled = false;
      $('summary').textContent = err.message;
    },
  });
}
$('go').addEventListener('click', go);
$('task').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
window.animo = { run: go };
if (params.has('run')) go();
