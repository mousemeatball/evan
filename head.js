// Spinning 3D head "logo" in the header. Spins faster while Evan is typing.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const IDLE_SPEED = 0.6;      // radians per second
const TYPING_SPEED = 3.2;
const SPEED_EASE = 3;        // how fast spin speed changes
const HEAD_FOCUS = 0.64;     // fraction of model height to centre on (face, not shirt)
const FRAME_FRACTION = 0.82; // fraction of model height visible in frame
const FOV = 30;

const canvas = document.getElementById("head");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const key = new THREE.DirectionalLight(0xfff1e0, 1.8);
key.position.set(30, 40, 50);
const rim = new THREE.DirectionalLight(0xdfe8ff, 1.1);
rim.position.set(-40, 20, -40);
scene.add(key, rim, new THREE.HemisphereLight(0xffffff, 0x8a7a6a, 0.35));

const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
const spinner = new THREE.Group();
scene.add(spinner);

let speed = IDLE_SPEED;
let targetSpeed = IDLE_SPEED;
let isLoaded = false;
window.evanHead = {
  setTyping(isTyping) { targetSpeed = isTyping ? TYPING_SPEED : IDLE_SPEED; },
  /** Web mode: the server hands out the head only after the passcode. @param {ArrayBuffer} buffer */
  loadBuffer(buffer) { if (!isLoaded) new GLTFLoader().parse(buffer, "", onModel, onModelError); },
};

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Re-centre so the head spins in place around the vertical axis.
  model.position.set(-center.x, -box.min.y, -center.z);
  const focusY = size.y * HEAD_FOCUS;
  const visible = size.y * FRAME_FRACTION;
  const dist = visible / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  camera.position.set(0, focusY, dist);
  camera.lookAt(0, focusY, 0);
}

function onModel(gltf) {
  isLoaded = true;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.map) o.material.map.anisotropy = 8;
    if (o.geometry.attributes.color) o.material.vertexColors = true;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
  });
  frameModel(gltf.scene);
  spinner.add(gltf.scene);
}

function onModelError(err) {
  console.error("Couldn't load head model", err);
}

// The Mac app bundles the head; over http(s) it waits for loadBuffer().
if (!(location.protocol === "http:" || location.protocol === "https:")) {
  new GLTFLoader().load("evan.glb", onModel, undefined, onModelError);
}

const clock = new THREE.Clock();
addEventListener("resize", resize);
resize();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  speed += (targetSpeed - speed) * Math.min(1, dt * SPEED_EASE);
  spinner.rotation.y += speed * dt;
  renderer.render(scene, camera);
});
