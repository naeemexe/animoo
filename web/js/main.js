import { createStage } from './stage.js';
import { createLook } from './look.js';
import { buildDemo } from './demo.js';
import { getHealth } from './api.js';

const stage = createStage(document.getElementById('app'));
buildDemo(stage.scene);
const look = createLook(stage.renderer, stage.scene, stage.camera);

window.addEventListener('resize', () => {
  stage.resize();
  look.setSize(window.innerWidth, window.innerHeight);
});

stage.renderer.setAnimationLoop(() => {
  stage.controls.update();
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

// For poking at the look from the console.
window.animo = { stage, look };
