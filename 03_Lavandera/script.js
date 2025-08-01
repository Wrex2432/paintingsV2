/* =====================================================================
   PHONE-AWARE PAINTING — COMPLETE SCRIPT  (Peek ping-pong enabled)
   ===================================================================== */


/* ──────────────────────────────────────────────────────────────────
   1. GLOBAL CONFIGURATION
   ──────────────────────────────────────────────────────────────────*/
const API_URL          = "http://localhost:8000";
const CAMERA_POLL_MS   = 2500;
const DETECT_INTERVAL  = 300;
const PHONE_TIMEOUT_MS = 3000;

/* Animation speeds (fps) */
const ANIM_MAIN_FPS = 30;  // Animate-In / Out
const ANIM_PEEK_FPS = 24;  // Peek ping-pong

/* Peek timing */
const PEEK_INTERVAL_MS = 5000;   // run a peek every second

/* Folder / file setup */
const scene             = "Lavandera";
const filePrefix        = "Lavandera";
const animateInLen      = 47;    
const animateOutLen     = 44;    
const animatePeekLen    = 12;  

const basePath          = `assets/${scene}/`;
const animateInPath     = `${basePath}Animate-In/`;
const animateOutPath    = `${basePath}Animate-Out/`;
const animatePeekPath   = `${basePath}Animate-Peek/`;
const staticDefault     = `${basePath}Static/${filePrefix}.jpg`;
const staticRemoved     = `${basePath}Static/${filePrefix}_Edited.jpg`;


/* ──────────────────────────────────────────────────────────────────
   2. DOM REFERENCES (populated on DOMContentLoaded)
   ──────────────────────────────────────────────────────────────────*/
let video, canvas, ctx;
let canvasPng, detectionContainer;
let statusInd, statusWrapper;
let videoWrapper;
let cycleBtn,  debugBtn;


/* ──────────────────────────────────────────────────────────────────
   3. STATE FLAGS
   ──────────────────────────────────────────────────────────────────*/
let videoDevices  = [];
let currentCamIdx = 0;
let stream        = null;

let assetsReady   = false;
let cameraReady   = false;
let isDetecting   = false;
let detectBusy    = false;

let debugMode     = false;
let hasPhone      = false;
let lastDetectionTime = 0;

let isAnimating   = false;
let currentState  = "default";   // 'default' | 'removed'
let pendingState  = null;        // queued visual change
let peekTimer     = null;        // fires Animate-Peek

/* Caches for every frame image element */
const imageMap = { in: [], out: [], peek: [], default: null, removed: null };


/* =====================================================================
   4. BOOTSTRAP
   =====================================================================*/
document.addEventListener("DOMContentLoaded", async () => {
  /* Grab DOM nodes */
  video              = document.getElementById("video");
  canvas             = document.getElementById("canvas");
  ctx                = canvas.getContext("2d");
  canvasPng          = document.getElementById("canvas-png");
  detectionContainer = document.getElementById("detection-container");
  statusInd          = document.getElementById("statusIndicator");
  statusWrapper      = document.querySelector(".status");
  videoWrapper       = document.querySelector(".video-wrapper");
  cycleBtn           = document.getElementById("cycleBtn");
  debugBtn           = document.getElementById("debugBtn");

  /* Listeners */
  window.addEventListener("keydown", onKey);
  cycleBtn.addEventListener("click", switchCamera);
  debugBtn.addEventListener("click", toggleDebugView);
  navigator.mediaDevices.addEventListener("devicechange", refreshDeviceList);

  updateStatus("waiting", "Loading painting …");

  /* Load images */
  await preloadPaintingImages();
  showDefaultPainting();                 // sets assetsReady

  /* Backend + camera */
  try {
    await verifyBackend();
    await requestCameraPermissionOnce();
    await refreshDeviceList();           // kicks camera init
  } catch (e) {
    updateStatus("error", e.message || "Init error");
  }
});


/* =====================================================================
   5. ASSET LOADING
   =====================================================================*/
async function preloadPaintingImages() {
  const total =
    animateInLen  + 1 +
    animateOutLen + 1 +
    animatePeekLen+ 1 +
    2; // two static

  let loaded = 0;
  const done = () => { if (++loaded === total) assetsReady = true; };

  const inject = (src, list, hidden = true) => {
    const img = new Image();
    img.src   = src;
    img.style = `position:absolute;top:0;left:0;width:100%;height:100%;
                 object-fit:contain;${hidden ? "visibility:hidden;" : ""}`;
    img.onload = img.onerror = done;
    canvasPng.appendChild(img);
    if (list) list.push(img);
    return img;
  };

  /* Static frames */
  imageMap.default = inject(staticDefault, null, false);
  imageMap.removed = inject(staticRemoved);

  /* Animated frames */
  for (let i = 0; i <= animateInLen; i++)
    inject(`${animateInPath}${filePrefix}${String(i).padStart(2,"0")}.jpg`,  imageMap.in);
  for (let i = 0; i <= animateOutLen; i++)
    inject(`${animateOutPath}${filePrefix}${String(i).padStart(2,"0")}.jpg`, imageMap.out);
  for (let i = 0; i <= animatePeekLen; i++)
    inject(`${animatePeekPath}${filePrefix}${String(i).padStart(2,"0")}.jpg`, imageMap.peek);
}

function hideAllFrames() {
  [...imageMap.in, ...imageMap.out, ...imageMap.peek,
   imageMap.default, imageMap.removed]
    .forEach(img => (img.style.visibility = "hidden"));
}

function showDefaultPainting() {
  hideAllFrames();
  imageMap.default.style.visibility = "visible";
  tryStartDetection();
}


/* =====================================================================
   6. CAMERA MANAGEMENT
   =====================================================================*/
async function refreshDeviceList() {
  videoDevices = (await navigator.mediaDevices.enumerateDevices())
                 .filter(d => d.kind === "videoinput");
  if (currentCamIdx >= videoDevices.length) currentCamIdx = 0;
  if (!stream) ensureCamera();
}

async function ensureCamera() {
  if (videoDevices.length === 0) {
    setTimeout(ensureCamera, CAMERA_POLL_MS);
    return;
  }
  try { await startCamera(videoDevices[currentCamIdx].deviceId); }
  catch { setTimeout(ensureCamera, CAMERA_POLL_MS); }
}

async function startCamera(deviceId) {
  if (stream) stopStream();
  stream = await navigator.mediaDevices.getUserMedia({
    video:{deviceId:{exact:deviceId},width:640,height:480}, audio:false
  });

  stream.getVideoTracks()[0].addEventListener("ended", () => {
    cameraReady = false; stopDetection(); stream = null; ensureCamera();
  });

  video.srcObject = stream;
  await new Promise(res => (video.onloadedmetadata = res));
  video.play();

  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;

  cameraReady = true;
  tryStartDetection();
}

function stopStream() { stream?.getTracks().forEach(t => t.stop()); stream = null; }

function switchCamera() {
  if (videoDevices.length < 2) return;
  currentCamIdx = (currentCamIdx + 1) % videoDevices.length;
  updateStatus("connecting", "Switching camera …");
  cameraReady = false; stopDetection(); ensureCamera();
}


/* =====================================================================
   7. START DETECTION WHEN READY
   =====================================================================*/
function tryStartDetection() {
  if (assetsReady && cameraReady && !isDetecting) {
    startDetectionLoop();
    if (!debugMode) statusWrapper.style.display = "none";
  }
}


/* =====================================================================
   8. YOLO DETECTION LOOP
   =====================================================================*/
function startDetectionLoop() {
  if (isDetecting) return;
  isDetecting = true;
  updateStatus("detecting", "Detecting …");
  detectOnce();
}

function stopDetection() { isDetecting = false; }

async function detectOnce() {
  if (isDetecting) setTimeout(detectOnce, DETECT_INTERVAL);
  if (!isDetecting || !stream || detectBusy) return;

  detectBusy = true;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.8));
    const fd   = new FormData();
    fd.append("file", blob);
    fd.append("confidence", 0.5);

    const res = await fetch(`${API_URL}/detect`, { method:"POST", body:fd });
    if (res.ok) {
      const { count, annotated_image } = await res.json();
      handleDetectionResult(count > 0);
      if (debugMode && annotated_image) drawAnnotated(annotated_image);
    }
  } catch (e) { console.error(e); }
  finally { detectBusy = false; }
}

function drawAnnotated(b64) {
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.src    = `data:image/jpeg;base64,${b64}`;
}


/* =====================================================================
   9. PHONE → VISUAL STATE
   =====================================================================*/
function handleDetectionResult(phone) {
  if (phone) {
    lastDetectionTime = Date.now();
    if (!hasPhone) {
      hasPhone = true;
      updateStatus("detecting", "📱 Phone detected");
      requestVisualState("removed");
    }
  } else if (hasPhone && Date.now() - lastDetectionTime > PHONE_TIMEOUT_MS) {
    hasPhone = false;
    updateStatus("waiting", "No phone");
    requestVisualState("default");
  }
  if (!debugMode) statusWrapper.style.display = "none";
}

function requestVisualState(target) {
  if (isAnimating) { pendingState = target; return; }
  if (currentState === target) return;

  stopPeek();                                // cancel any peek timer

  if (target === "removed") {
    currentState = "removed";
    playSequence("out", animateOutLen, imageMap.removed, false, startPeek);
  } else {
    currentState = "default";
    playSequence("in", animateInLen, imageMap.default);
  }
}


/* =====================================================================
   10. ANIMATION ENGINE
   =====================================================================*/
/* fallbackTo defined EARLIER to avoid ReferenceError */
function fallbackTo(img) {
  hideAllFrames();
  img.style.visibility = "visible";
  isAnimating = false;
  if (pendingState) { const n = pendingState; pendingState = null; requestVisualState(n); }
}

/**
 * playSequence(type, len, fallback, pingPong=false, onDone?)
 *  – forward 0→len; if pingPong=true it then reverses len-1→0
 */
function playSequence(type, len, fallback, pingPong = false, onDone) {
  if (isAnimating) return;

  const frames = imageMap[type];
  if (!frames || frames.length === 0) { fallbackTo(fallback); return; }

  isAnimating = true;
  let forward = true, idx = 0;
  const fps   = type === "peek" ? ANIM_PEEK_FPS : ANIM_MAIN_FPS;

  const timer = setInterval(() => {
    hideAllFrames(); frames[idx].style.visibility = "visible";
    forward ? idx++ : idx--;

    const finishedForward = forward && idx > len;
    const finishedReverse = !forward && idx < 0;

    if (finishedForward) {
      if (pingPong) { forward = false; idx = len - 1; }
      else          { clearInterval(timer); fallbackTo(fallback); onDone?.(); }
    } else if (finishedReverse) {
      clearInterval(timer); fallbackTo(fallback); onDone?.();
    }
  }, 1000 / fps);
}


/* ------------------------------------------------------------------
   Peek helpers
   ------------------------------------------------------------------ */
function startPeek() {
  stopPeek();
  peekTimer = setInterval(() => {
    if (!isAnimating && currentState === "removed") {
      playSequence("peek", animatePeekLen, imageMap.removed, true);
    }
  }, PEEK_INTERVAL_MS);
}
function stopPeek() { if (peekTimer) { clearInterval(peekTimer); peekTimer = null; }}


/* =====================================================================
   11. UI — STATUS & DEBUG
   =====================================================================*/
function toggleDebugView() {
  debugMode = !debugMode;

  videoWrapper.style.display       = debugMode ? "flex"  : "none";
  canvas.style.display             = debugMode ? "block" : "none";
  detectionContainer.style.display = debugMode ? "block" : "none";
  canvasPng.style.display          = debugMode ? "none"  : "block";
  statusWrapper.style.display      = debugMode ? "block" : "none";

  if (!debugMode) detectionContainer.innerHTML = "";
}

function updateStatus(type, text) {
  statusInd.className = `status-indicator status-${type}`;
  statusInd.innerHTML = (type === "connecting" || type === "detecting")
                        ? `<div class="loading"></div>${text}`
                        : text;
  if (debugMode) statusWrapper.style.display = "block";
}


/* =====================================================================
   12. BACKEND HELPERS
   =====================================================================*/
async function verifyBackend() {
  updateStatus("connecting", "Connecting backend …");
  const r = await fetch(`${API_URL}/`);
  if (!r.ok) throw new Error("Backend offline");
  const { model_loaded } = await r.json();
  if (!model_loaded) throw new Error("Model not loaded");
}
async function requestCameraPermissionOnce() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach(t => t.stop());
  } catch { /* ignore */ }
}


/* =====================================================================
   13. HOTKEYS
   =====================================================================*/
function onKey(e) {
  const k = e.key.toLowerCase();
  if (k === "q") switchCamera();
  if (k === "c") toggleDebugView();
}
