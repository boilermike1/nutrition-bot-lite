// Cloudflare Worker for Nutrition Bot Lite
//  - POST /      Telegram webhook: replies OK instantly, forwards the update to Apps Script
//  - GET  /scan  Barcode scanner page that opens inside Telegram (Mini App)
// Secrets (Worker > Settings > Variables and Secrets), never in this file:
//   APPS_SCRIPT_URL  your Apps Script deployment URL ending in /exec
//   WEBHOOK_SECRET   same value as WEBHOOK_SECRET in Config.gs

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/scan') {
      return new Response(SCANNER_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // Browser visits / health checks
    if (request.method !== 'POST') return new Response('OK');

    // Only accept requests from Telegram carrying your secret
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const body = await request.text();

    // Forward to Apps Script in the background...
    ctx.waitUntil(
      fetch(`${env.APPS_SCRIPT_URL}?secret=${encodeURIComponent(env.WEBHOOK_SECRET)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        redirect: 'manual' // Apps Script answers with a 302 after running; no need to follow it
      }).catch(err => console.log('Forward to Apps Script failed: ' + err))
    );

    // ...while telling Telegram "delivered" immediately, so it never retries
    return new Response('OK');
  }
};

// Scanner page (v3).
//  - A successful scan (live, photo or typed) sends the code straight to the bot and closes; the bot
//    replies with a normal draft. The optional portion box sits above the camera and is read at that moment.
//  - Decoder: the phone's built-in barcode detector when it has one (most Android phones);
//    otherwise ZXing-C++ compiled to WebAssembly (barcode-detector 3.2.2), which handles blur,
//    tilt, curved packages and small barcodes far better than the previous library.
//  - Full-HD camera feed and the whole frame is searched, so the barcode doesn't need to fill a box.
//  - Zoom, light and camera-switch buttons when the phone supports them.
//  - "Take a photo" fallback uses the phone's own camera (best focus), then decodes the photo.
const SCANNER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Scan barcode</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root {
    --bg: var(--tg-theme-bg-color, #ffffff);
    --text: var(--tg-theme-text-color, #111111);
    --hint: var(--tg-theme-hint-color, #777777);
    --btn: var(--tg-theme-button-color, #2481cc);
    --btn-text: var(--tg-theme-button-text-color, #ffffff);
    --card: var(--tg-theme-secondary-bg-color, #f2f2f5);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px 24px; background: var(--bg); color: var(--text);
         font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 19px; margin: 0 0 10px; }
  #view { position: relative; width: 100%; aspect-ratio: 4 / 3; background: #000; border-radius: 14px; overflow: hidden; }
  #video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .guide { position: absolute; left: 8%; right: 8%; top: 30%; bottom: 30%;
           border: 2px solid rgba(255,255,255,.85); border-radius: 10px; pointer-events: none;
           box-shadow: 0 0 0 9999px rgba(0,0,0,.25); }
  .guide::after { content: ""; position: absolute; left: 6%; right: 6%; top: 50%; height: 2px;
                  background: rgba(255,70,70,.9); }
  #view.found .guide { border-color: #34c759; }
  .row { display: flex; gap: 8px; margin-top: 10px; }
  .row button { flex: 1; margin-top: 0; }
  .hint { color: var(--hint); font-size: 14px; margin: 10px 0; }
  .card { background: var(--card); border-radius: 12px; padding: 14px; margin-top: 12px; }
  .code { font-size: 24px; font-weight: 600; letter-spacing: 1px; margin-bottom: 10px; }
  label { display: block; font-size: 14px; color: var(--hint); margin-bottom: 6px; }
  input[type=text], input[inputmode] { width: 100%; padding: 10px 12px; font-size: 16px; border-radius: 10px;
          border: 1px solid rgba(127,127,127,.35); background: var(--bg); color: var(--text); }
  button { margin-top: 10px; padding: 10px 12px; font-size: 15px; border: 0; border-radius: 10px;
           background: var(--btn); color: var(--btn-text); width: 100%; }
  button.secondary { background: transparent; color: var(--btn); border: 1px solid var(--btn); }
  button.on { background: var(--btn); color: var(--btn-text); }
  details { margin-top: 14px; }
  summary { color: var(--btn); cursor: pointer; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <h1>Scan a barcode</h1>
  <label for="note">Portion: fill in before scanning, or leave blank for 1 label serving</label>
  <input id="note" type="text" placeholder="e.g. 2 servings, half the bag, 40g" autocomplete="off" enterkeyhint="done">
  <div id="view" style="margin-top: 10px"><video id="video" playsinline muted autoplay></video><div class="guide"></div></div>

  <div class="row" id="camControls">
    <button id="zoomBtn" class="secondary" hidden>🔍 Zoom</button>
    <button id="torchBtn" class="secondary" hidden>🔦 Light</button>
    <button id="camBtn" class="secondary" hidden>🔄 Camera</button>
  </div>

  <p class="hint" id="status">Starting camera…</p>

  <button id="photoBtn" class="secondary">📸 Take a photo of the barcode instead</button>
  <input id="photo" type="file" accept="image/*" capture="environment" hidden>

  <details id="manualBox">
    <summary>Type the number instead</summary>
    <div class="card">
      <label for="manual">Barcode digits</label>
      <input id="manual" inputmode="numeric" placeholder="12 or 13 digits">
      <button id="useManual">Use this number</button>
      <p class="hint" id="manualMsg"></p>
    </div>
  </details>

<script type="module">
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); // don't close the scanner while moving the phone
  }
  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  var detector = null, stream = null, track = null, scanning = false, busy = false, current = null;
  var cams = [], camIndex = 0, zoomed = false, torchOn = false;
  var ANGLES = [0, 30, -30], tickN = 0, rotCanvas = document.createElement('canvas');

  // A copy of the image turned by the given angle, so barcodes held at a slant still read
  function rotated(src, w, h, deg) {
    rotCanvas.width = w; rotCanvas.height = h;
    var g = rotCanvas.getContext('2d');
    g.save(); g.translate(w / 2, h / 2); g.rotate(deg * Math.PI / 180); g.drawImage(src, -w / 2, -h / 2, w, h); g.restore();
    return rotCanvas;
  }

  function status(t) { $('status').textContent = t; }

  // ---- barcode check digit (same rules as the bot) ----
  function validGtin(code) {
    var d = code.split('').map(Number), check = d.pop(), sum = 0;
    d.reverse().forEach(function (n, i) { sum += n * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === check;
  }
  function expandUpcE(e) {
    var ns = e[0], d = e.slice(1, 7), chk = e[7], last = d[5], body;
    if ('012'.indexOf(last) !== -1) body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
    else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
    else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
    else body = d.slice(0, 5) + '0000' + last;
    return ns + body + chk;
  }
  function normalize(raw) {
    var d = String(raw || '').replace(/\\D/g, '');
    if (d.length === 8) {
      if (/^[01]/.test(d)) { var a = expandUpcE(d); if (validGtin(a)) return a; }
      return validGtin(d) ? d : null;
    }
    return [12, 13, 14].indexOf(d.length) !== -1 && validGtin(d) ? d : null;
  }
  function firstValid(codes) {
    for (var i = 0; i < (codes || []).length; i++) {
      var c = normalize(codes[i].rawValue);
      if (c) return c;
    }
    return null;
  }

  // ---- decoder: built-in if it supports grocery barcodes, otherwise ZXing (WebAssembly) ----
  async function makeDetector() {
    try {
      if ('BarcodeDetector' in window) {
        var supported = await window.BarcodeDetector.getSupportedFormats();
        if (supported.indexOf('ean_13') !== -1 && supported.indexOf('upc_a') !== -1) {
          return new window.BarcodeDetector({ formats: FORMATS });
        }
      }
    } catch (e) {}
    var mod = await import('https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/dist/es/ponyfill.js');
    return new mod.BarcodeDetector({ formats: FORMATS });
  }

  // ---- camera ----
  async function listBackCameras() {
    try {
      var all = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === 'videoinput'; });
      var back = all.filter(function (d) { return /back|rear|environment|wide|triple|dual/i.test(d.label); });
      cams = back.length ? back : all;
    } catch (e) { cams = []; }
    $('camBtn').hidden = cams.length < 2;
  }

  async function openCamera(deviceId) {
    stopCamera();
    var video0 = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (deviceId) video0.deviceId = { exact: deviceId }; else video0.facingMode = { ideal: 'environment' };
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video0 });
    video.srcObject = stream;
    await video.play().catch(function () {});
    track = stream.getVideoTracks()[0];
    var caps = (track.getCapabilities && track.getCapabilities()) || {};
    if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    }
    // Zoom lets you hold the phone farther away, where the camera can focus
    $('zoomBtn').hidden = !(caps.zoom && caps.zoom.max >= 1.5);
    if (!$('zoomBtn').hidden) setZoom(true);
    $('torchBtn').hidden = !caps.torch;
    torchOn = false; $('torchBtn').classList.remove('on');
  }

  function stopCamera() {
    scanning = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; track = null;
  }

  function setZoom(on) {
    if (!track) return;
    var caps = track.getCapabilities ? track.getCapabilities() : {};
    if (!caps.zoom) return;
    zoomed = on;
    var z = on ? Math.min(2, caps.zoom.max) : Math.max(1, caps.zoom.min || 1);
    track.applyConstraints({ advanced: [{ zoom: z }] }).catch(function () {});
    $('zoomBtn').textContent = on ? '🔍 Zoom 2×' : '🔍 Zoom 1×';
    $('zoomBtn').classList.toggle('on', on);
  }

  // ---- live scanning loop: searches the whole frame several times a second ----
  async function tick() {
    if (!scanning) return;
    if (!busy && video.readyState >= 2 && detector) {
      busy = true;
      try {
        var deg = ANGLES[tickN++ % ANGLES.length]; // straight, then slanted each way
        var src = deg ? rotated(video, video.videoWidth, video.videoHeight, deg) : video;
        var code = firstValid(await detector.detect(src));
        if (code) { found(code); busy = false; return; }
      } catch (e) {}
      busy = false;
    }
    setTimeout(tick, 60);
  }

  async function startScanning(deviceId) {
    current = null;
    $('view').classList.remove('found');
    try {
      status('Starting camera…');
      await openCamera(deviceId);
      await listBackCameras();
      if (!detector) { status('Loading scanner…'); detector = await makeDetector(); }
      status('Hold the phone 15–30 cm from the barcode. It can be at an angle; it doesn\\'t need to be flat.');
      scanning = true;
      tick();
    } catch (err) {
      status('Camera unavailable (' + (err && err.message ? err.message : err) + '). Use "Take a photo" or type the number.');
      $('manualBox').open = true;
    }
  }

  // A good scan goes straight to the bot, which replies with a draft to confirm
  function found(code) {
    if (current) return; // already sending
    stopCamera();
    current = code;
    $('view').classList.add('found');
    status('Got ' + code + '. Sending…');
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    setTimeout(send, 250); // let the buzz and green frame show before the scanner closes
  }

  // ---- photo fallback: the phone's own camera focuses best ----
  async function decodePhoto(file) {
    status('Reading the photo…');
    try {
      if (!detector) detector = await makeDetector();
      var bmp = await createImageBitmap(file);
      var tries = [1600, 3000, 0]; // try a smaller copy first (faster), then larger, then full size
      for (var i = 0; i < tries.length; i++) {
        var max = tries[i], scale = max ? Math.min(1, max / Math.max(bmp.width, bmp.height)) : 1;
        var c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        for (var j = 0; j < ANGLES.length; j++) {
          var src = ANGLES[j] ? rotated(c, c.width, c.height, ANGLES[j]) : c;
          var code = firstValid(await detector.detect(src));
          if (code) { found(code); return; }
        }
        if (scale === 1) break;
      }
      status('No barcode found in that photo. Try again with the barcode filling more of the picture, or type the number.');
      $('manualBox').open = true;
    } catch (e) {
      status('Could not read that photo (' + (e && e.message ? e.message : e) + '). Type the number instead.');
      $('manualBox').open = true;
    }
  }

  function send() {
    if (!current) return;
    var payload = JSON.stringify({ type: 'barcode', code: current, note: $('note').value.trim() });
    if (tg && tg.sendData) tg.sendData(payload); // closes the scanner and delivers the code to the bot
    else status('Open this page from the "Scan barcode" button in Telegram to send it.');
  }

  // ---- buttons ----
  $('zoomBtn').addEventListener('click', function () { setZoom(!zoomed); });
  $('torchBtn').addEventListener('click', function () {
    if (!track) return;
    torchOn = !torchOn;
    track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () {});
    $('torchBtn').classList.toggle('on', torchOn);
  });
  $('camBtn').addEventListener('click', function () {
    if (cams.length < 2) return;
    camIndex = (camIndex + 1) % cams.length;
    startScanning(cams[camIndex].deviceId);
    status('Using: ' + (cams[camIndex].label || 'camera ' + (camIndex + 1)));
  });
  $('photoBtn').addEventListener('click', function () { stopCamera(); $('photo').click(); });
  $('photo').addEventListener('change', function () {
    var f = $('photo').files && $('photo').files[0];
    if (f) decodePhoto(f);
    $('photo').value = '';
  });
  $('useManual').addEventListener('click', function () {
    var code = normalize($('manual').value);
    if (!code) { $('manualMsg').textContent = 'That number does not check out. A digit may be off.'; return; }
    $('manualMsg').textContent = '';
    found(code);
  });

  startScanning();
</script>
</body>
</html>`;
