// The app shell: one storybook stage, two pages (Chat | Movie), switched by
// the URL hash (#chat, #movie). Each page owns a group in the scene and a
// per-frame update; only the visible page's run.
import * as THREE from 'three';
import { createStage } from './stage.js';
import { createLook } from './look.js';
import { getHealth } from './api.js';
import { createChatPage } from './chat/page.js';
import { createMoviePage } from './movie/page.js';
import { tickAtmosphere } from './movie/atmosphere.js';

const stage = createStage(document.getElementById('app'));
const look = createLook(stage.renderer, stage.scene, stage.camera);

const pages = {
  chat: createChatPage(document.getElementById('page-chat'), stage, look),
  movie: createMoviePage(document.getElementById('page-movie'), stage, look),
};
let current = null;

function show(name) {
  if (!pages[name]) name = 'movie';
  if (current === name) return;
  pages[current]?.hide();
  for (const [id, el] of Object.entries({ chat: 'page-chat', movie: 'page-movie' })) {
    document.getElementById(el).hidden = id !== name;
  }
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.page === name));
  current = name;
  pages[name].show();
}
const pageName = () => location.hash.slice(1).split('?')[0];
window.addEventListener('hashchange', () => show(pageName()));
show(pageName() || 'movie');

window.addEventListener('resize', () => {
  stage.resize();
  look.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
stage.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  pages[current].frame(dt);
  tickAtmosphere(dt, stage.camera);
  // A hidden tab or a collapsed pane has a 0×0 window; render targets of that
  // size are incomplete framebuffers, so skip the frame.
  if (!window.innerWidth || !window.innerHeight) return;
  look.render();
});

const status = document.getElementById('status');
getHealth()
  .then((h) => {
    if (h.service === 'static') {
      status.textContent = 'static preview (no backend)';
      status.className = 'pill warn';
    } else {
      status.textContent = 'backend ok';
      status.className = 'pill ok';
    }
  })
  .catch((err) => {
    status.textContent = 'backend offline';
    status.className = 'pill bad';
    console.warn('health check failed:', err.message);
  });

// For poking from the console.
window.animo = { stage, look, pages, show };
