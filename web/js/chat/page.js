// The Chat page (task 10). For now: the primitive demo village and a note.
import { buildDemo } from '../demo.js';
import { setTimeOfDay } from '../movie/world.js';

export function createChatPage(root, stage) {
  let village = null;
  return {
    show() {
      if (!village) {
        const before = new Set(stage.scene.children);
        buildDemo(stage.scene);
        village = stage.scene.children.filter((o) => !before.has(o));
      }
      village.forEach((o) => { o.visible = true; });
      setTimeOfDay(stage, 'golden');
      stage.controls.enabled = true;
      stage.resize();
    },
    hide() { village?.forEach((o) => { o.visible = false; }); },
    frame() { stage.controls.update(); },
  };
}
