// Post-processing for the storybook look:
// soft ink outlines (depth + normal edges, thinner on small things) → golden-hour
// grade → depth of field focused on the shot's subject → tone map.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const LOOK = {
  outlineColor: new THREE.Color(0.2, 0.12, 0.08), // multiplied into the colour: warm ink
  outlineStrength: 0.95,
  outlineThickness: 1.6, // in device pixels at pixel ratio 1
  shadowTint: new THREE.Color(0.86, 0.84, 1.05), // lilac shadows
  highlightTint: new THREE.Color(1.08, 0.98, 0.84), // gold highlights
  saturation: 1.12,
  exposure: 1.05,
  vignette: 0.35,
  // Depth of field: everything at `focus` meters from the camera is sharp, and
  // the blur grows with the distance from that plane, up to `blur` pixels
  // (at pixel ratio 1). The director sets both per shot (none in wide shots).
  focus: 20,
  blur: 3,
  focusDepth: 0.18, // the sharp zone: ± this fraction of the focus distance
};

// Ink width per object, by its size: a 2 m+ thing gets the full line, a 0.4 m
// prop about half. Stored in the normal pass's alpha.
export function inkFor(size) {
  return THREE.MathUtils.clamp(0.3 + size * 0.35, 0.4, 1);
}

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CompositeShader = {
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    tNormal: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 1 },
    cameraFar: { value: 200 },
    outlineColor: { value: LOOK.outlineColor },
    outlineStrength: { value: LOOK.outlineStrength },
    outlineThickness: { value: LOOK.outlineThickness },
    shadowTint: { value: LOOK.shadowTint },
    highlightTint: { value: LOOK.highlightTint },
    saturation: { value: LOOK.saturation },
    exposure: { value: LOOK.exposure },
    vignette: { value: LOOK.vignette },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tColor;
    uniform sampler2D tDepth;
    uniform sampler2D tNormal;
    uniform vec2 resolution;
    uniform float cameraNear, cameraFar;
    uniform vec3 outlineColor, shadowTint, highlightTint;
    uniform float outlineStrength, outlineThickness, saturation, exposure, vignette;
    varying vec2 vUv;

    float linearDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      return cameraNear * cameraFar / (cameraFar - z * (cameraFar - cameraNear));
    }
    vec3 normalAt(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      // Line width: the thinnest object around this pixel sets it, so a small
      // prop gets a thin line on both sides of its silhouette.
      vec2 px0 = outlineThickness / resolution;
      float ink = texture2D(tNormal, vUv).a;
      ink = min(ink, texture2D(tNormal, vUv + vec2(px0.x, 0.0)).a);
      ink = min(ink, texture2D(tNormal, vUv - vec2(px0.x, 0.0)).a);
      ink = min(ink, texture2D(tNormal, vUv + vec2(0.0, px0.y)).a);
      ink = min(ink, texture2D(tNormal, vUv - vec2(0.0, px0.y)).a);
      vec2 px = px0 * max(ink, 0.35);
      vec2 dx = vec2(px.x, 0.0), dy = vec2(0.0, px.y);

      // Depth edges: second derivative, so flat surfaces at grazing angles stay clean.
      float d = linearDepth(vUv);
      float dl = linearDepth(vUv - dx), dr = linearDepth(vUv + dx);
      float dd = linearDepth(vUv - dy), du = linearDepth(vUv + dy);
      float lap = (abs(dl + dr - 2.0 * d) + abs(du + dd - 2.0 * d)) / d;
      float depthEdge = smoothstep(0.012, 0.045, lap);

      // Normal edges: creases between faces.
      vec3 n = normalAt(vUv);
      float nd = (1.0 - dot(n, normalAt(vUv - dx))) + (1.0 - dot(n, normalAt(vUv + dx)))
               + (1.0 - dot(n, normalAt(vUv - dy))) + (1.0 - dot(n, normalAt(vUv + dy)));
      float normalEdge = smoothstep(0.3, 0.9, nd);

      // Thin lines are fainter too, so small props don't get scribbled over.
      float edge = max(depthEdge, normalEdge) * mix(0.55, 1.0, smoothstep(0.35, 0.9, ink));
      edge *= 1.0 - smoothstep(cameraFar * 0.5, cameraFar * 0.8, d); // no ink on the sky

      vec3 col = texture2D(tColor, vUv).rgb;
      col = mix(col, col * outlineColor, edge * outlineStrength);

      // Golden-hour grade: lilac shadows, gold highlights, a little extra colour.
      col *= exposure;
      col *= mix(shadowTint, highlightTint, smoothstep(0.04, 0.6, luma(col)));
      col = max(mix(vec3(luma(col)), col, saturation), 0.0);

      // Warm vignette.
      vec2 q = vUv - 0.5;
      float v = smoothstep(0.25, 0.85, length(q * vec2(1.2, 1.0)));
      col *= mix(vec3(1.0), vec3(0.78, 0.6, 0.5), v * vignette * 2.0);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// One axis of a separable depth-of-field blur. The circle of confusion comes
// from the depth buffer: zero inside the sharp zone around the focus distance,
// growing in front of and behind it. Each tap is weighted by its own blur, so a
// sharp subject doesn't bleed a halo into the blurred background behind it.
const DofShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 1 },
    cameraFar: { value: 200 },
    direction: { value: new THREE.Vector2(1, 0) }, // one texel along the blur axis, × pixel ratio
    focus: { value: LOOK.focus },
    depthOfField: { value: LOOK.focusDepth },
    amount: { value: LOOK.blur },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar, focus, depthOfField, amount;
    uniform vec2 direction;
    varying vec2 vUv;
    float coc(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      float d = cameraNear * cameraFar / (cameraFar - z * (cameraFar - cameraNear));
      float off = max(0.0, abs(d - focus) - focus * depthOfField);
      // Behind the subject the blur levels off; in front it grows faster.
      return clamp(off / max(d, 0.5) * (d < focus ? 2.5 : 1.6), 0.0, 1.0);
    }
    void main() {
      float c = coc(vUv);
      vec4 sum = texture2D(tDiffuse, vUv);
      float wsum = 1.0;
      if (amount * c > 0.25) {
        vec2 o = direction * amount * c / 4.0;
        for (int i = 1; i <= 4; i++) {
          float g = exp(-float(i * i) / 8.0);
          for (int s = -1; s <= 1; s += 2) {
            vec2 uv = vUv + o * float(i * s);
            // A sharper neighbour only counts as far as its own blur reaches.
            float w = g * clamp(coc(uv) * 4.0 / float(i), 0.0, 1.0);
            sum += texture2D(tDiffuse, uv) * w;
            wsum += w;
          }
        }
      }
      gl_FragColor = sum / wsum;
    }
  `,
};

// The normal pass: view-space normal in rgb, the object's ink width in alpha.
// Works for skinned, morphed and instanced meshes through three's chunks.
function createNormalMaterial() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ink: { value: 1 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      varying vec3 vNormalV;
      void main() {
        #include <beginnormal_vertex>
        #include <morphnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <project_vertex>
        vNormalV = normalize(transformedNormal);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float ink;
      varying vec3 vNormalV;
      void main() { gl_FragColor = vec4(normalize(vNormalV) * 0.5 + 0.5, ink); }
    `,
  });
  // Per object: the ink width it was tagged with (by the set builder or
  // here, from its root's size), uploaded just before it draws.
  mat.onBeforeRender = (renderer, scene, camera, geometry, object) => {
    const v = object.userData.ink ?? inkOf(object);
    if (v !== mat.uniforms.ink.value) {
      mat.uniforms.ink.value = v;
      mat.uniformsNeedUpdate = true;
    }
  };
  return mat;
}

// An untagged mesh: the size of the top-level thing it belongs to (a prop's
// window pane gets the house's line), measured once.
const _box = new THREE.Box3(), _size = new THREE.Vector3();
function inkOf(object) {
  let root = object;
  while (root.parent && !root.userData.prop && !root.userData.inkRoot && root.parent.type !== 'Scene' && !/^(set|fill)$/.test(root.parent.name)) root = root.parent;
  if (root.userData.ink == null) {
    if (object.isInstancedMesh) {
      // One instance's size: the geometry at the first instance's scale.
      if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
      const m = new THREE.Matrix4();
      object.getMatrixAt(0, m);
      root.userData.ink = inkFor(object.geometry.boundingSphere.radius * 2 * m.getMaxScaleOnAxis());
    } else {
      _box.setFromObject(root).getSize(_size);
      root.userData.ink = inkFor(Math.max(_size.x, _size.y, _size.z));
    }
  }
  object.userData.ink = root.userData.ink;
  return object.userData.ink;
}

export function createLook(renderer, scene, camera) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);

  // The scene goes to its own target so the composite can read colour and depth.
  // Frame cost (task 21, measured on an M4 at 1432×755, pixel ratio 2): 4× MSAA on this half-float
  // target plus half-float normals held 45–47 fps; without MSAA and with 8-bit normals, 60. On a
  // retina screen the ink outlines hide the jaggies, so MSAA is only kept below pixel ratio 1.75.
  const samples = renderer.getPixelRatio() >= 1.75 ? 0 : 4;
  const sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  sceneRT.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
  // Normals only feed the edge test, so 8 bits per channel are plenty.
  const normalRT = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.UnsignedByteType });
  const normalMaterial = createNormalMaterial();

  const composer = new EffectComposer(renderer);

  // 'tUnused' keeps the composer from overwriting tColor with its empty read buffer.
  const composite = new ShaderPass(CompositeShader, 'tUnused');
  composite.uniforms.tColor.value = sceneRT.texture;
  composite.uniforms.tDepth.value = sceneRT.depthTexture;
  composite.uniforms.tNormal.value = normalRT.texture;
  composer.addPass(composite);

  const dofH = new ShaderPass(DofShader);
  const dofV = new ShaderPass(DofShader);
  for (const p of [dofH, dofV]) p.uniforms.tDepth.value = sceneRT.depthTexture;
  composer.addPass(dofH);
  composer.addPass(dofV);
  composer.addPass(new OutputPass());

  function setSize(width, height) {
    const pr = renderer.getPixelRatio();
    const w = Math.floor(width * pr), h = Math.floor(height * pr);
    sceneRT.setSize(w, h);
    normalRT.setSize(w, h);
    composer.setSize(width, height);
    composite.uniforms.resolution.value.set(w, h);
    // Blur scales with pixel ratio so it looks the same on retina screens.
    dofH.uniforms.direction.value.set(pr / w, 0);
    dofV.uniforms.direction.value.set(0, pr / h);
  }
  setSize(window.innerWidth, window.innerHeight);

  // Depth of field: focus on a point (followed every frame) or at a distance.
  const focus = { point: null, distance: LOOK.focus, blur: LOOK.blur };
  function setFocus({ point, distance, blur } = {}) {
    if (point !== undefined) focus.point = point;
    if (distance !== undefined) focus.distance = distance;
    if (blur !== undefined) focus.blur = blur;
  }

  function render() {
    composite.uniforms.cameraNear.value = camera.near;
    composite.uniforms.cameraFar.value = camera.far;
    const fd = focus.point ? camera.position.distanceTo(focus.point) : focus.distance;
    for (const p of [dofH, dofV]) {
      p.uniforms.cameraNear.value = camera.near;
      p.uniforms.cameraFar.value = camera.far;
      p.uniforms.focus.value = fd;
      p.uniforms.amount.value = focus.blur;
    }

    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // Normal pass: same scene, view-space normals, no sky, no shadow re-render.
    const background = scene.background;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    scene.background = null;
    // Sprites, particles and glows would draw as solid shapes with the override.
    const skip = [];
    for (const o of scene.userData.noNormal ?? []) if (o.visible) { o.visible = false; skip.push(o); }
    scene.overrideMaterial = normalMaterial;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(normalRT);
    const clear = renderer.getClearColor(new THREE.Color()), clearA = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    for (const o of skip) o.visible = true;
    scene.background = background;
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setClearColor(clear, clearA);
    renderer.setRenderTarget(null);

    composer.render();
  }

  return { render, setSize, setFocus, focus, composer, sceneRT, normalRT, uniforms: { composite: composite.uniforms, dofH: dofH.uniforms, dofV: dofV.uniforms } };
}
