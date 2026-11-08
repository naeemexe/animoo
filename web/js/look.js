// Post-processing for the storybook look:
// soft ink outlines (depth + normal edges) → golden-hour grade → tilt-shift → tone map.
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
  tiltFocus: 0.48, // screen height of the sharp band (0 = bottom)
  tiltBand: 0.1, // half-height of the sharp band
  tiltBlur: 9, // pixels per tap at full distance
};

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
      vec2 px = outlineThickness / resolution;
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

      float edge = max(depthEdge, normalEdge);
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

// One axis of a tilt-shift blur: sharp band around `focus`, blur grows outside it.
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null },
    direction: { value: new THREE.Vector2(1, 0) }, // one texel along the blur axis
    focus: { value: LOOK.tiltFocus },
    band: { value: LOOK.tiltBand },
    amount: { value: LOOK.tiltBlur },
  },
  vertexShader: FULLSCREEN_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 direction;
    uniform float focus, band, amount;
    varying vec2 vUv;
    void main() {
      float k = max(0.0, abs(vUv.y - focus) - band) * amount;
      vec2 o = direction * k;
      vec4 s = texture2D(tDiffuse, vUv) * 0.1633;
      s += (texture2D(tDiffuse, vUv + o)       + texture2D(tDiffuse, vUv - o))       * 0.1531;
      s += (texture2D(tDiffuse, vUv + o * 2.0) + texture2D(tDiffuse, vUv - o * 2.0)) * 0.12245;
      s += (texture2D(tDiffuse, vUv + o * 3.0) + texture2D(tDiffuse, vUv - o * 3.0)) * 0.0918;
      s += (texture2D(tDiffuse, vUv + o * 4.0) + texture2D(tDiffuse, vUv - o * 4.0)) * 0.051;
      gl_FragColor = s;
    }
  `,
};

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
  const normalMaterial = new THREE.MeshNormalMaterial();

  const composer = new EffectComposer(renderer);

  // 'tUnused' keeps the composer from overwriting tColor with its empty read buffer.
  const composite = new ShaderPass(CompositeShader, 'tUnused');
  composite.uniforms.tColor.value = sceneRT.texture;
  composite.uniforms.tDepth.value = sceneRT.depthTexture;
  composite.uniforms.tNormal.value = normalRT.texture;
  composer.addPass(composite);

  const tiltH = new ShaderPass(TiltShiftShader);
  const tiltV = new ShaderPass(TiltShiftShader);
  composer.addPass(tiltH);
  composer.addPass(tiltV);
  composer.addPass(new OutputPass());

  function setSize(width, height) {
    const pr = renderer.getPixelRatio();
    const w = Math.floor(width * pr), h = Math.floor(height * pr);
    sceneRT.setSize(w, h);
    normalRT.setSize(w, h);
    composer.setSize(width, height);
    composite.uniforms.resolution.value.set(w, h);
    // Blur scales with pixel ratio so it looks the same on retina screens.
    tiltH.uniforms.direction.value.set(pr / w, 0);
    tiltV.uniforms.direction.value.set(0, pr / h);
  }
  setSize(window.innerWidth, window.innerHeight);

  function render() {
    composite.uniforms.cameraNear.value = camera.near;
    composite.uniforms.cameraFar.value = camera.far;

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
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    scene.overrideMaterial = null;
    for (const o of skip) o.visible = true;
    scene.background = background;
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.setRenderTarget(null);

    composer.render();
  }

  return { render, setSize, composer, sceneRT, normalRT, uniforms: { composite: composite.uniforms, tiltH: tiltH.uniforms, tiltV: tiltV.uniforms } };
}
