/**
 * Controle remoto da YTPowerFeed (página do celular).
 * Conversa direto com a aba do YouTube no PC (content/remote.js da extensão) por WebRTC. A oferta e a
 * resposta passam por um tópico do ntfy.sh, criptografadas com a chave do QR code (AES-GCM); o tópico
 * sai da própria chave (SHA-256). A chave vem no "#k=" do link e fica guardada neste aparelho.
 */

import { qrcode } from "./vendor/qrcode.js";

const RELAY = "https://ntfy.sh";
const ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
const CHUNK = 3000;
const STORE = "ytpf-remote-key";
const me = `ph-${Math.random().toString(36).slice(2, 10)}`;

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Pareamento
// ---------------------------------------------------------------------------------------------
function readKey() {
  const m = /[#&]k=([\w-]{40,})/.exec(location.hash);
  if (m) {
    try { localStorage.setItem(STORE, m[1]); } catch (err) {}
    history.replaceState(null, "", location.pathname + location.search);
    return m[1];
  }
  try { return localStorage.getItem(STORE) || ""; } catch (err) { return ""; }
}

// ---------------------------------------------------------------------------------------------
// Criptografia e sinalização (a mesma do content/remote.js)
// ---------------------------------------------------------------------------------------------
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

async function keys(secret) {
  const raw = b64.dec(secret);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const topic = `ytpf-${Array.from(hash.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { topic, key };
}

async function seal(key, obj) {
  const plain = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("deflate-raw"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64.enc(out);
}

async function unseal(key, text) {
  const bytes = b64.dec(text);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(await pipe(new Uint8Array(plain), new DecompressionStream("deflate-raw"))));
}

async function publish(ctx, obj) {
  const data = await seal(ctx.key, obj);
  const id = Math.random().toString(36).slice(2, 10);
  const n = Math.ceil(data.length / CHUNK);
  for (let p = 0; p < n; p++) {
    const r = await fetch(`${RELAY}/${ctx.topic}?cache=no`, {
      method: "POST",
      body: JSON.stringify({ f: me, i: id, p, n, d: data.slice(p * CHUNK, (p + 1) * CHUNK) })
    });
    // O ntfy.sh grátis aceita 250 mensagens por dia por endereço de internet (o PC e o celular no
    // mesmo Wi-Fi contam juntos); passou disso, responde 429 até o dia virar
    if (r.status === 429) throw Object.assign(new Error("limite do ntfy"), { quota: true });
    if (!r.ok) throw new Error(`ntfy: HTTP ${r.status}`);
  }
}

const parts = new Map();
function reassemble(env) {
  if (env.n === 1) return env.d;
  const slot = parts.get(env.i) || { got: [], at: Date.now() };
  slot.got[env.p] = env.d;
  parts.set(env.i, slot);
  if (slot.got.filter((x) => x !== undefined).length < env.n) return null;
  parts.delete(env.i);
  return slot.got.join("");
}

const deviceName = () => {
  const ua = navigator.userAgent;
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (m && !/^K$/.test(m[1])) return m[1].trim();
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Celular Android";
  return "Celular";
};

// ---------------------------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------------------------
let ctx = null;
let es = null;
let esAlive = 0;      // último sinal do ntfy nesta escuta (abertura, keepalive ou mensagem)
let esReady = null;   // promessa: escuta aberta
let esAt = 0;         // quando a escuta foi aberta
let pc = null;
let dc = null;
let waiting = null;   // recebe a resposta do PC à oferta em andamento
let gen = 0;          // tentativa mais nova: uma tentativa velha para no próximo passo
let attempt = 0;      // tentativa em andamento (0: nenhuma)
let attemptAt = 0;
let retryTimer = 0;
let fails = 0;
let quotaUntil = 0;   // limite diário do ntfy.sh atingido: sem tentar até esse horário
let pcUpdated = false; // a extensão foi atualizada no PC (a aba antiga avisou antes de largar)

// Versão da extensão no PC, ao lado do nome (fica a última conhecida)
function showVersion(ver) {
  if (typeof ver !== "string" || !/^[\d.]{1,20}$/.test(ver)) return;
  const el = $("pcVer");
  if (el.textContent !== `v${ver}`) el.textContent = `v${ver}`;
  el.hidden = false;
}

function setUpdated(on) {
  pcUpdated = on;
  $("updNotice").hidden = !on;
}

function setConn(state, text) {
  const qr = $("qrRow");
  if (qr && identity) qr.hidden = state === "on";
  $("conn").dataset.state = state;
  $("connText").textContent = text;
}

// Escuta do tópico, por onde chega a resposta do PC. Depois de o celular dormir ou trocar de rede, a
// escuta pode continuar "aberta" sem receber mais nada (a conexão morreu calada): por isso ela é
// aberta de novo ao voltar e quando o ntfy fica calado (ele manda um keepalive a cada ~45 s)
function listenRelay() {
  es?.close();
  const mine = new EventSource(`${RELAY}/${ctx.topic}/sse`);
  es = mine;
  esAlive = 0;
  esAt = Date.now();
  const alive = () => { if (es === mine) esAlive = Date.now(); };
  mine.addEventListener("keepalive", alive);
  mine.onmessage = async (e) => {
    alive();
    try {
      const env = JSON.parse(JSON.parse(e.data).message || "null");
      if (!env || env.f === me || typeof env.d !== "string") return;
      const text = reassemble(env);
      if (!text) return;
      const msg = await unseal(ctx.key, text);
      if (msg.type === "answer" && msg.to === me && waiting) waiting(msg);
    } catch (err) {}
  };
  esReady = new Promise((resolve) => {
    mine.addEventListener("open", () => { alive(); resolve(); });
    setTimeout(resolve, 4000);
  });
  return esReady;
}
// Escuta que deu sinal há pouco, ou que acabou de ser aberta (e ainda está abrindo)
const relayFresh = () => !!es && es.readyState !== EventSource.CLOSED &&
  (Date.now() - esAlive < 60000 || (!esAlive && Date.now() - esAt < 4000));

// Sem "trickle": manda os candidatos numa mensagem só. Não espera todos: com um do STUN (srflx) já
// conecta, então espera só mais um pouco por outros (antes eram até 3 s esperando os que não vêm)
function iceDone(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let quiet = 0;
    const t = setTimeout(() => done(), 2500);
    const done = () => { clearTimeout(t); clearTimeout(quiet); resolve(); };
    peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") done(); });
    peer.addEventListener("icecandidate", (e) => {
      if (!e.candidate) { done(); return; }
      if (/ typ srflx /.test(e.candidate.candidate)) { clearTimeout(quiet); quiet = setTimeout(done, 300); }
    });
  });
}

// Celular trancado: o sistema congela a página e a conexão morre sem avisar (o canal continua
// "aberto" por um tempo). Ao voltar, e a cada poucos segundos sem notícia do PC, o celular manda
// um "ping"; sem resposta em 1,5 s, a conexão é dada como morta e ele procura o PC de novo, sozinho
const PING_MS = 1500;
let lastMsgAt = 0;
let pingTimer = 0;
let hiddenAt = 0;
let awayMs = 0;       // quanto tempo a página ficou escondida da última vez (para o diagnóstico)
let lastTick = Date.now();

function dropConnection() {
  const old = dc;
  dc = null;
  try { old?.close(); } catch (err) {}
  try { pc?.close(); } catch (err) {}
  pc = null;
}

// Para a tentativa em andamento (ela pode ter ficado parada com a página congelada)
function abandonAttempt() {
  if (!attempt) return;
  gen++;
  attempt = 0;
  waiting = null;
  if (dc?.readyState !== "open") dropConnection();
}

function reconnectNow() {
  clearTimeout(pingTimer);
  pingTimer = 0;
  setConn("wait", "Reconectando…");
  abandonAttempt();
  dropConnection();
  fails = 0;
  // A rede deu problema: a escuta do ntfy pode ter morrido junto (abre de novo, junto com o ICE)
  esAlive = 0;
  // Primeiro a vaga de reconexão (local, sem ntfy); sem ela, ou se falhar, o ntfy
  if (spare) useSpare().then((ok) => { if (!ok) connect(); });
  else connect();
}

function check(force) {
  if (!ctx || document.hidden || attempt && Date.now() - attemptAt < 20000) return;
  if (attempt) abandonAttempt();
  // Desconectado: só uma volta do usuário procura o PC na hora; o resto fica com o scheduleRetry,
  // que espera cada vez mais (cada tentativa gasta mensagens do ntfy, que tem limite por dia)
  if (spareBusy) return;
  if (dc?.readyState !== "open") { if (force) { fails = 0; if (spare) reconnectNow(); else connect(); } return; }
  // O próprio WebRTC já viu que caiu: nem precisa do ping
  if (pc && ["failed", "closed"].includes(pc.connectionState)) { reconnectNow(); return; }
  if (pingTimer || (!force && Date.now() - lastMsgAt < 3000)) return;
  const sentAt = Date.now();
  try { dc.send(JSON.stringify({ c: "ping" })); } catch (err) {}
  pingTimer = setTimeout(() => {
    pingTimer = 0;
    if (lastMsgAt >= sentAt || document.hidden) return;
    reconnectNow();
  }, PING_MS);
}

// Voltou de um tempo escondida ou congelada (ou trocou de rede): a escuta do ntfy e a tentativa em
// andamento não valem mais; a escuta é aberta de novo já, junto com o ping
function wake(e) {
  if (document.hidden) { hiddenAt = hiddenAt || Date.now(); return; }
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  const slept = away > 2000 || ["online", "resume", "frozen-gap"].includes(e?.type);
  hiddenAt = 0;
  if (away > 2000) awayMs = away;
  if (slept && ctx) {
    abandonAttempt();
    if (!relayFresh() || esAlive) listenRelay();
  }
  // Mais de 25 s trancado: o PC já desistiu da conexão (30 s sem resposta); sem esperar o ping
  if (spare && !spareBusy && (away > 25000 || e?.type === "frozen-gap")) { reconnectNow(); return; }
  check(true);
}

// ---------------------------------------------------------------------------------------------
// Conexão sem serviço de fora: identidade fixa deste celular (certificado guardado no IndexedDB) e
// QR de conexão do PC. O PC guarda a impressão digital do certificado (mandada aqui ao conectar, ou
// lida pela webcam no QR de pareamento, ou digitada como código) e, com ela, monta sozinho a
// resposta deste celular; o QR do PC traz os endereços dele e o usuário e a senha de ICE que este
// celular deve usar. A conta do código é a mesma do popup/remote-id.js da extensão
// ---------------------------------------------------------------------------------------------
let identity = null; // { cert, fp ("AB:CD:…"), code (56 caracteres) }
const KNOWN = "ytpf-remote-known";
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("ytpf-remote", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function toBase32(bytes) {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

async function loadIdentity() {
  const db = await idb();
  const get = (k) => new Promise((resolve) => {
    const q = db.transaction("kv").objectStore("kv").get(k);
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => resolve(null);
  });
  let cert = await get("cert");
  // Certificado novo um mês antes de vencer (aí o PC aprende o novo na próxima conexão)
  if (!cert || cert.expires < Date.now() + 30 * 864e5) {
    const algo = { name: "ECDSA", namedCurve: "P-256" };
    cert = await RTCPeerConnection.generateCertificate({ ...algo, expires: 360 * 864e5 }).catch(() => RTCPeerConnection.generateCertificate(algo));
    await new Promise((resolve) => {
      const t = db.transaction("kv", "readwrite");
      t.objectStore("kv").put(cert, "cert");
      t.oncomplete = resolve;
      t.onerror = resolve;
    });
  }
  const fp = cert.getFingerprints().find((f) => f.algorithm === "sha-256").value.toUpperCase();
  const bytes = Uint8Array.from(fp.split(":"), (h) => parseInt(h, 16));
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const code = toBase32([...bytes, sum[0], sum[1], sum[2]]);
  return { cert, fp, code };
}

// O PC já conhece este celular: o cartão de pareamento some
function setKnown(on) {
  try { if (on) localStorage.setItem(KNOWN, identity?.fp || ""); } catch (err) {}
  const card = $("pairCard");
  if (card) card.hidden = on;
}

function drawQr(canvas, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), margin = 3, cell = Math.max(2, Math.floor(200 / (n + margin * 2)));
  const size = cell * (n + margin * 2);
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
}

function renderPairCard() {
  if (!identity) return;
  let known = "";
  try { known = localStorage.getItem(KNOWN) || ""; } catch (err) {}
  drawQr($("pairQr"), `YTPF1:${identity.code}`);
  $("pairCode").textContent = identity.code.replace(/(.{4})(?=.)/g, "$1-");
  $("pairCard").hidden = known === identity.fp;
}

// Leitor do QR de conexão do PC (o Chrome do Android lê QR sozinho: BarcodeDetector)
let scanStream = null;
let scanOn = false;

function stopScan() {
  scanOn = false;
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  if ($("scanSheet").open) $("scanSheet").close();
}

async function scanPcQr() {
  if (!("BarcodeDetector" in window)) { toast("Este navegador não lê QR code"); return; }
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  $("scanMsg").textContent = "Abrindo a câmera…";
  $("scanSheet").showModal();
  if (!await openCamera(0)) {
    stopScan();
    toast("Sem acesso à câmera");
    return;
  }
  $("scanMsg").textContent = "Aponte para o QR de conexão no PC";
  scanOn = true;
  const video = $("scanVideo");
  const tick = async () => {
    if (!scanOn) return;
    let text = "";
    try { text = (await detector.detect(video)).map((c) => c.rawValue).find((t) => t.startsWith("YTPF2:")) || ""; } catch (err) {}
    if (text) {
      $("scanMsg").textContent = "Conectando…";
      scanOn = false;
      const ok = await connectByInvite(text);
      if (ok) stopScan();
      else { $("scanMsg").textContent = "Não conectou. No PC, gere outro QR e aponte de novo"; scanOn = true; setTimeout(tick, 1500); }
      return;
    }
    setTimeout(tick, 200);
  };
  tick();
}

// Câmera do leitor: o "traseira" que o Chrome escolhe sozinho pode ser a ultra-wide, que não foca
// de perto (Galaxy S23). Com a permissão dada, lista as traseiras, a principal primeiro (nos
// Android, "camera2 0"), e fica com a primeira que tem foco automático; a escolhida fica guardada.
// "Trocar câmera" passa para a próxima
const CAM = "ytpf-remote-cam";
let cams = [];
let camIdx = 0;

const camOrder = (d) => { const m = /camera2?\s*(\d+)/i.exec(d.label); return m ? Number(m[1]) : 50; };

async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput" && d.deviceId);
  const back = devs.filter((d) => /back|rear|traseira|environment/i.test(d.label));
  return (back.length ? back : devs).sort((a, b) => camOrder(a) - camOrder(b));
}

async function startStream(deviceId) {
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    : { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } };
  const stream = await navigator.mediaDevices.getUserMedia({ video });
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};
  const focus = Array.isArray(caps.focusMode) && caps.focusMode.includes("continuous");
  if (focus) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  return { stream, focus };
}

function useStream(stream) {
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = stream;
  const video = $("scanVideo");
  video.srcObject = stream;
  video.play().catch(() => {});
}

async function openCamera(step) {
  try {
    if (!cams.length) {
      // Primeiro uma câmera qualquer: sem permissão, a lista vem sem os nomes
      const first = await startStream("");
      cams = await listCameras();
      let saved = "";
      try { saved = localStorage.getItem(CAM) || ""; } catch (err) {}
      const savedIdx = cams.findIndex((d) => d.deviceId === saved);
      if (savedIdx >= 0 || cams.length < 2) {
        camIdx = Math.max(0, savedIdx);
        if (!cams.length) { useStream(first.stream); return true; }
        first.stream.getTracks().forEach((t) => t.stop());
        useStream((await startStream(cams[camIdx].deviceId)).stream);
      } else {
        first.stream.getTracks().forEach((t) => t.stop());
        // A primeira traseira com foco automático (na ordem: a principal antes)
        let pick = null;
        for (let i = 0; i < cams.length && !pick; i++) {
          const s = await startStream(cams[i].deviceId).catch(() => null);
          if (s?.focus) { pick = s; camIdx = i; }
          else s?.stream.getTracks().forEach((t) => t.stop());
        }
        if (!pick) { camIdx = 0; pick = await startStream(cams[0].deviceId); }
        useStream(pick.stream);
      }
    } else {
      camIdx = (camIdx + step + cams.length) % cams.length;
      useStream((await startStream(cams[camIdx].deviceId)).stream);
    }
    try { if (cams[camIdx]) localStorage.setItem(CAM, cams[camIdx].deviceId); } catch (err) {}
    $("btnScanSwitch").hidden = cams.length < 2;
    return true;
  } catch (err) {
    return false;
  }
}

async function unpackInvite(text) {
  const bytes = b64.dec(text.slice("YTPF2:".length));
  return JSON.parse(new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw"))));
}

async function connectByInvite(text) {
  if (!identity || spareBusy) return false;
  let inv;
  try { inv = await unpackInvite(text); } catch (err) { return false; }
  if (!inv || typeof inv.u !== "string" || typeof inv.p !== "string" || !/^[0-9A-F]{64}$/i.test(inv.f || "") || !Array.isArray(inv.c)) return false;
  const t0 = performance.now();
  spareBusy = true;
  try {
    abandonAttempt();
    dropConnection();
    clearTimeout(retryTimer);
    setConn("wait", "Conectando pelo QR…");
    // A oferta do PC, remontada: o SDP de uma oferta deste mesmo Chrome com o usuário, a senha e a
    // impressão digital do PC, mais os endereços dele
    const tmp = new RTCPeerConnection();
    tmp.createDataChannel("ytpf");
    const base = (await tmp.createOffer()).sdp;
    tmp.close();
    const fpPc = inv.f.toUpperCase().match(/../g).join(":");
    const lines = base.split("\r\n").filter((l) => l && !l.startsWith("a=candidate:"))
      .map((l) => (l.startsWith("a=ice-ufrag:") ? `a=ice-ufrag:${inv.u}`
        : l.startsWith("a=ice-pwd:") ? `a=ice-pwd:${inv.p}`
        : l.startsWith("a=fingerprint:") ? `a=fingerprint:sha-256 ${fpPc}` : l));
    const offer = [...lines, ...inv.c.filter((c) => typeof c === "string").slice(0, 20).map((c) => `a=${c}`)].join("\r\n") + "\r\n";
    const peer = new RTCPeerConnection({ iceServers: [], certificates: [identity.cert] });
    const chanP = new Promise((resolve) => { peer.ondatachannel = (e) => resolve(e.channel); });
    await peer.setRemoteDescription({ type: "offer", sdp: offer });
    const ans = await peer.createAnswer();
    const munged = ans.sdp.split("\r\n").map((l) => (l.startsWith("a=ice-ufrag:") ? `a=ice-ufrag:${inv.pu}`
      : l.startsWith("a=ice-pwd:") ? `a=ice-pwd:${inv.pp}` : l)).join("\r\n");
    await peer.setLocalDescription({ type: "answer", sdp: munged });
    const chan = await Promise.race([chanP, new Promise((r) => setTimeout(() => r(null), 5000))]);
    const open = chan && await new Promise((resolve) => {
      if (chan.readyState === "open") return resolve(true);
      chan.addEventListener("open", () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 3000);
    });
    if (!open) {
      try { peer.close(); } catch (err) {}
      diag(`O QR não conectou (ICE: ${peer.iceConnectionState})`, null);
      setConn("off", "Não conectou pelo QR");
      return false;
    }
    wireChannel(peer, chan, null);
    diag(`Conectou pelo QR em ${Math.round(performance.now() - t0)} ms`, peer);
    return true;
  } catch (err) {
    diag(`O QR não conectou: ${err?.message || err}`, null);
    setConn("off", "Não conectou pelo QR");
    return false;
  } finally {
    spareBusy = false;
  }
}

// Canal com o PC (pelo ntfy ou pela vaga): a mesma ligação dos eventos
function wireChannel(peer, chan, onOpened) {
  pc = peer;
  dc = chan;
  let done = false; // o "open" pode vir depois de o canal já chegar aberto: uma vez só
  const opened = () => {
    if (dc !== chan || done) return;
    done = true;
    fails = 0;
    lastMsgAt = Date.now();
    setConn("on", "Conectado");
    setUpdated(false);
    send({ c: "hello", name: deviceName() });
    if (identity) send({ c: "identity", fp: identity.fp });
    showTab(tab, true);
    onOpened?.();
  };
  chan.onopen = opened;
  chan.onclose = () => { if (dc !== chan) return; dc = null; setConn("off", "Desconectado"); scheduleRetry(true); };
  chan.onmessage = (e) => { lastMsgAt = Date.now(); try { onMessage(JSON.parse(e.data)); } catch (err) {} };
  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    if (peer.connectionState === "failed") { dropConnection(); setConn("off", "A conexão caiu"); scheduleRetry(true); }
    else if (peer.connectionState === "disconnected") check(true);
  };
  if (chan.readyState === "open") opened();
}

// ---------------------------------------------------------------------------------------------
// Vaga de reconexão: com a conexão viva, o PC manda pelo canal os dados de uma conexão nova, e o
// celular monta o lado dele e responde (sem os endereços dele). As duas pontas ficam paradas até a
// conexão cair: aí o celular entrega à vaga os endereços do PC e ela conecta, sem passar pelo ntfy.
// Só endereços da rede local (sem STUN)
// ---------------------------------------------------------------------------------------------
let spare = null;     // { id, pc, cands, chan }
let spareBusy = false;

function closeSpare() {
  const s = spare;
  spare = null;
  try { s?.pc.close(); } catch (err) {}
}

async function onSpare(m) {
  if (typeof m.id !== "string" || typeof m.sdp !== "string" || !Array.isArray(m.cands)) return;
  closeSpare();
  const peer = new RTCPeerConnection({ iceServers: [] });
  const s = { id: m.id, pc: peer, cands: m.cands.filter((c) => typeof c === "string").slice(0, 20) };
  s.chan = new Promise((resolve) => { peer.ondatachannel = (e) => resolve(e.channel); });
  spare = s;
  await peer.setRemoteDescription({ type: "offer", sdp: m.sdp });
  await peer.setLocalDescription(await peer.createAnswer());
  if (spare !== s) return;
  const bare = peer.localDescription.sdp.split("\r\n").filter((l) => !l.startsWith("a=candidate:") && !l.startsWith("a=end-of-candidates")).join("\r\n");
  send({ c: "spareAnswer", id: s.id, sdp: bare });
}

async function useSpare() {
  const s = spare;
  spare = null;
  if (!s || spareBusy) return false;
  spareBusy = true;
  const t0 = performance.now();
  // Na rede local a vaga conecta em milissegundos: sem resposta em 2 s, ela não vale mais (a aba do
  // PC foi recarregada, por exemplo)
  const away = awayMs ? ` depois de ${fmtAway(awayMs)} escondida` : "";
  try {
    for (const c of s.cands) await s.pc.addIceCandidate({ candidate: c, sdpMid: "0", sdpMLineIndex: 0 }).catch(() => {});
    const chan = await Promise.race([s.chan, new Promise((r) => setTimeout(() => r(null), 2000))]);
    const open = chan && await new Promise((resolve) => {
      if (chan.readyState === "open") return resolve(true);
      chan.addEventListener("open", () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 1500);
    });
    if (!open) {
      diag(`A vaga falhou${away} (ICE: ${s.pc.iceConnectionState}); procurando pelo ntfy`, null);
      try { s.pc.close(); } catch (err) {}
      return false;
    }
    wireChannel(s.pc, chan, null);
    diag(`Voltou pela vaga em ${Math.round(performance.now() - t0)} ms${away}`, s.pc);
    return true;
  } finally {
    spareBusy = false;
    awayMs = 0;
  }
}

const fmtAway = (ms) => ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;

// Diagnóstico (fase de teste): como voltou e por qual caminho, os últimos eventos guardados
async function routeOf(peer) {
  if (!peer) return "";
  try {
    const st = await peer.getStats();
    let pairId = "";
    st.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
    let pair = null;
    st.forEach((r) => { if (r.type === "candidate-pair" && (r.id === pairId || (!pairId && r.nominated && r.state === "succeeded"))) pair = r; });
    if (!pair) return "";
    const l = st.get(pair.localCandidateId), rm = st.get(pair.remoteCandidateId);
    const local = (c) => c && (c.candidateType === "host" || (c.candidateType === "prflx" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fe80|fd|fc)/i.test(c.address || "")));
    const how = local(l) && local(rm) ? "direto na rede local" : "pelo roteador";
    return `${how} (${l?.candidateType || "?"} → ${rm?.candidateType || "?"})`;
  } catch (err) {
    return "";
  }
}

let diagLog = [];
try { diagLog = JSON.parse(localStorage.getItem("ytpf-remote-diag") || "[]"); } catch (err) {}
async function diag(text, peer) {
  // O caminho só aparece depois que a conexão escolhe o par de endereços
  if (peer) await new Promise((r) => setTimeout(r, 400));
  const route = await routeOf(peer);
  const at = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  diagLog = [`${at} · ${text}${route ? ` · ${route}` : ""}`, ...diagLog].slice(0, 6);
  try { localStorage.setItem("ytpf-remote-diag", JSON.stringify(diagLog)); } catch (err) {}
  renderDiag();
}
function renderDiag() {
  const box = $("diag");
  if (!box) return;
  box.replaceChildren(...diagLog.map((line, i) => {
    const li = document.createElement("li");
    li.textContent = line;
    if (i === 0) li.className = "last";
    return li;
  }));
  box.hidden = !diagLog.length;
}

async function connect() {
  if (attempt && Date.now() - attemptAt < 20000) return;
  if (dc?.readyState === "open") return;
  if (Date.now() < quotaUntil) { showQuota(); return; }
  abandonAttempt();
  const my = ++gen;
  const stale = () => my !== gen;
  attempt = my;
  attemptAt = Date.now();
  clearTimeout(retryTimer);
  setConn("wait", "Procurando o PC…");
  try {
    // A escuta abre enquanto os candidatos são juntados
    const ready = relayFresh() ? esReady : listenRelay();
    try { pc?.close(); } catch (err) {}
    const peer = new RTCPeerConnection({ iceServers: ICE });
    const chan = peer.createDataChannel("ytpf");
    const t0 = performance.now();
    wireChannel(peer, chan, () => diag(`Conectou pelo ntfy em ${Math.round(performance.now() - t0)} ms`, peer));
    await peer.setLocalDescription(await peer.createOffer());
    await Promise.all([iceDone(peer), ready]);
    if (stale()) return;
    // Cada oferta tem um id, que o PC devolve: uma resposta atrasada a uma oferta velha não serve
    const oid = Math.random().toString(36).slice(2, 10);
    const answer = new Promise((resolve, reject) => {
      waiting = (m) => { if (m.o === undefined || m.o === oid) resolve(m); };
      setTimeout(() => reject(new Error("sem resposta")), 8000);
    });
    await publish(ctx, { type: "offer", o: oid, sdp: peer.localDescription.sdp, name: deviceName() });
    const msg = await answer;
    if (stale()) return;
    waiting = null;
    await peer.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    // Conectando: o onopen do canal confirma
    setTimeout(() => { if (dc === chan && chan.readyState !== "open") { dropConnection(); scheduleRetry(); } }, 8000);
  } catch (err) {
    if (stale()) return;
    waiting = null;
    if (err?.quota) { await onQuota(); return; }
    fails++;
    esAlive = 0; // a próxima tentativa abre a escuta de novo: pode ter sido ela que morreu
    setConn("off", fails > 1 ? (pcUpdated ? "Recarregue o YouTube no PC" : "PC não encontrado. Abra ou recarregue o YouTube no PC") : "Procurando o PC…");
    scheduleRetry();
  } finally {
    if (attempt === my) attempt = 0;
  }
}

// Sem o PC: tenta de novo em 2, 5, 10, 20, 40 e 60 s; depois de 10 tentativas, só quando o usuário
// voltar para a página ou tocar no estado da conexão
const RETRY_S = [2, 5, 10, 20, 40, 60];
function scheduleRetry(soon) {
  clearTimeout(retryTimer);
  if (document.hidden) return;
  if (!soon && fails >= 10) { setConn("off", "PC não encontrado. Toque aqui para procurar"); return; }
  retryTimer = setTimeout(connect, soon ? 300 : RETRY_S[Math.min(fails, RETRY_S.length) - 1] * 1000 || 2000);
}

async function onQuota() {
  let reset = 0;
  try { reset = ((await (await fetch(`${RELAY}/v1/account`)).json())?.stats?.reset_at || 0) * 1000; } catch (err) {}
  quotaUntil = reset > Date.now() ? reset : Date.now() + 30 * 60000;
  showQuota();
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (!document.hidden) { fails = 0; connect(); } }, Math.min(quotaUntil - Date.now() + 5000, 2 ** 31 - 1));
}

function showQuota() {
  const at = new Date(quotaUntil).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  setConn("off", `Limite diário do ntfy.sh atingido. Volta às ${at}`);
}

function send(obj) {
  if (dc?.readyState === "open") { dc.send(JSON.stringify(obj)); check(false); }
  else wake();
}

// Tocar no estado da conexão procura o PC na hora
$("conn").addEventListener("click", () => { if (dc?.readyState !== "open") wake({ type: "tap" }); });

// Ao destravar o celular ou voltar para a página: confere a conexão e, morta, procura o PC
document.addEventListener("visibilitychange", wake);
document.addEventListener("resume", wake);
window.addEventListener("pageshow", wake);
window.addEventListener("online", wake);
window.addEventListener("focus", wake);
// Com a página à vista: conexão parada (sem notícia do PC) volta sozinha. Um intervalo bem maior
// que o normal entre as voltas quer dizer que a página ficou congelada
setInterval(() => {
  const gap = Date.now() - lastTick;
  lastTick = Date.now();
  if (gap > 10000) wake({ type: "frozen-gap" });
  else check(false);
}, 3000);

// ---------------------------------------------------------------------------------------------
// Tocando agora
// ---------------------------------------------------------------------------------------------
let st = { videoId: "", state: -1, time: 0, duration: 0, rate: 1 };
let stAt = 0;
let seeking = false;
let volDragging = false;
let lastThumb = "";
let queue = { items: [], cur: -1 };

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const thumbUrl = (id, q = "mqdefault") => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
const setFill = (input) => input.style.setProperty("--p", `${(input.value - input.min) / (input.max - input.min) * 100}%`);

function onMessage(m) {
  if (m.t === "state") {
    showVersion(m.ver);
    // O que o celular acabou de mudar fica como está até o PC confirmar (sem voltar e ir)
    for (const [k, p] of Object.entries(pend)) {
      if (performance.now() < p.until && m.videoId === p.videoId) m[k] = p.v;
      else delete pend[k];
    }
    st = m;
    stAt = performance.now();
    if (m.queue) { queue = m.queue; if (tab === "queue") renderQueue(); }
    renderNow();
  } else if (m.t === "list") {
    if (m.auto && m.which === "subs") onSubsAuto(m.items || []);
    else if (m.which === tab && (tab !== "search" || m.q === lastQuery)) renderList(m.items, m.error, !!m.auto);
  } else if (m.t === "home") {
    home = { sections: m.sections || [], chips: m.chips || [], chip: m.chip || 0, def: m.def ?? -1, items: m.items || [], cont: m.cont || "", error: m.error || "", wlSlot: m.wlSlot ?? -1, wlRows: m.wlRows || 1 };
    if (tab === "home") renderHome();
  } else if (m.t === "recs") {
    onRecs(m);
  } else if (m.t === "wlChanged") {
    onWlChanged(m);
  } else if (m.t === "wlList") {
    setWlItems(withWlEdits(m.items || []));
  } else if (m.t === "tabs") {
    renderTabs(m.items || [], m.pin || 0);
  } else if (m.t === "chapters") {
    renderChapters(m.videoId === st.videoId ? m.items || [] : []);
  } else if (m.t === "captions") {
    renderCaptions(m.items || [], m.cur || "");
  } else if (m.t === "known") {
    setKnown(true);
  } else if (m.t === "spare") {
    onSpare(m).catch((err) => diag(`Vaga não preparada: ${err?.message || err}`));
  } else if (m.t === "toast") {
    toast(m.text);
  } else if (m.t === "updated") {
    setUpdated(true);
  }
}

function renderNow() {
  const has = !!st.videoId;
  $("btnTarget").classList.toggle("pinned", !!st.pinned);
  setText($("targetText"), st.pinned ? `Travado na aba: ${st.tabTitle || "YouTube"}` : "Toca na aba em foco do PC");
  $("nowTitle").textContent = has ? st.title || "…" : "Nada tocando";
  $("nowChannel").textContent = has ? st.channel || "" : "Abra um vídeo pela lista abaixo";
  $("nowBadge").hidden = !st.ad;
  if (has && lastThumb !== st.videoId) {
    lastThumb = st.videoId;
    const img = $("nowThumb");
    img.classList.remove("loaded");
    img.onload = () => img.classList.add("loaded");
    img.src = thumbUrl(st.videoId, "hqdefault");
    $("ambient").style.backgroundImage = `url("${thumbUrl(st.videoId)}")`;
    $("ambient").classList.add("on");
  } else if (!has) {
    lastThumb = "";
    $("nowThumb").classList.remove("loaded");
    $("ambient").classList.remove("on");
  }
  $("btnPlay").classList.toggle("playing", st.state === 1 || st.state === 3);
  $("btnMute").classList.toggle("muted", !!st.muted || st.volume === 0);
  if (!volDragging) { $("vol").value = st.muted ? 0 : st.volume; setFill($("vol")); }
  markRate();
  $("btnFs").classList.toggle("on", !!st.fs);
  for (const b of $("resSeg").children) b.classList.toggle("on", b.dataset.res === st.resMode);
  $("tDur").textContent = fmt(st.duration);
  renderActs(has);
}

// ---------------------------------------------------------------------------------------------
// Ações do vídeo atual: Gostei, Assistir mais tarde, Capítulos, Legendas e Timer
// ---------------------------------------------------------------------------------------------
const pend = {}; // mudado aqui, esperando o PC: chave → { v, videoId, until }
function hold(k, v) {
  st[k] = v;
  pend[k] = { v, videoId: st.videoId, until: performance.now() + 3000 };
}

function setAct(id, on, enabled) {
  const b = $(id);
  b.classList.toggle("on", !!on);
  if (b.hasAttribute("aria-pressed")) b.setAttribute("aria-pressed", String(!!on));
  b.disabled = !enabled;
}

function renderActs(has) {
  setAct("btnLike", has && st.liked, has && !st.ad);
  setAct("btnWl", has && st.inWl, has && !st.ad);
  setAct("btnChap", false, has && st.chapters > 0);
  setAct("btnCc", has && st.cc, has && st.ccCount > 0);
  setAct("btnSleep", !!st.sleep, true);
  sleepTick();
}

// Contagem do timer no botão (anda entre uma atualização e outra)
function sleepLeft() {
  if (!st.sleep || st.sleep.end) return null;
  return Math.max(0, (st.sleep.left || 0) - (performance.now() - stAt) / 1000);
}
function sleepTick() {
  const left = sleepLeft();
  const text = st.sleep?.end ? "fim" : left != null ? fmt(Math.ceil(left)) : "";
  setText($("sleepText"), text);
  $("btnSleep").setAttribute("aria-label", text ? `Timer para desligar: ${st.sleep.end ? "no fim deste vídeo" : `faltam ${text}`}` : "Timer para desligar");
}

const SLEEP_OPTS = [0, 15, 30, 45, 60, 90, "end"];
let sleepPick = 0;
function renderSleep() {
  const cur = !st.sleep ? 0 : st.sleep.end ? "end" : sleepPick || -1;
  $("sleepList").replaceChildren(...SLEEP_OPTS.map((o, i) => tabOpt({
    on: o === cur,
    icon: o === 0 ? ICON_OFF : o === "end" ? ICON_END : ICON_MOON,
    title: o === 0 ? "Desligado" : o === "end" ? "No fim deste vídeo" : `${o} min`,
    sub: o === cur && o !== 0 && o !== "end" && sleepLeft() != null ? `Faltam ${fmt(Math.ceil(sleepLeft()))}` : "",
    onTap: () => {
      sleepPick = typeof o === "number" ? o : 0;
      if (o === "end" && !st.videoId) { toast("Nada tocando no PC"); return; }
      send(o === 0 ? { c: "sleep" } : o === "end" ? { c: "sleep", end: true } : { c: "sleep", min: o });
      $("sleepSheet").close();
    }
  }, i)));
}

// Capítulos: o atual marcado, acompanhando o tempo
let chapters = [];
let chapCur = -1;
function renderChapters(items) {
  chapters = items;
  chapCur = -1;
  const list = $("chapList");
  if (!items.length) { list.replaceChildren(emptyEl("Este vídeo não tem capítulos")); return; }
  list.replaceChildren(...items.map((c, i) => {
    const b = document.createElement("button");
    b.className = "chap";
    b.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    if (/^https:\/\//.test(c.thumb || "")) img.src = c.thumb;
    const txt = document.createElement("span");
    txt.className = "txt";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = c.title || `Capítulo ${i + 1}`;
    const tm = document.createElement("div");
    tm.className = "c";
    tm.textContent = fmt(c.start);
    txt.append(t, tm);
    b.append(img, txt);
    b.addEventListener("click", () => {
      send({ c: "seek", time: c.start });
      st.time = c.start;
      stAt = performance.now();
      markChapter(true);
      setTimeout(() => $("chapSheet").close(), 180);
    });
    return b;
  }));
  markChapter(false, true);
}
function markChapter(smooth, scroll) {
  if (!chapters.length) return;
  const t = curTime();
  let i = 0;
  while (i + 1 < chapters.length && chapters[i + 1].start <= t + 0.25) i++;
  if (i === chapCur && !scroll) return;
  chapCur = i;
  const rows = $("chapList").children;
  for (let k = 0; k < rows.length; k++) rows[k].classList.toggle("on", k === i);
  if (scroll && rows[i]) rows[i].scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "instant" });
}

function renderCaptions(items, cur) {
  const set = (vssId) => {
    send({ c: "ccSet", vssId });
    hold("cc", !!vssId);
    renderNow();
    $("ccSheet").close();
  };
  const opts = [{ on: !cur, icon: ICON_OFF, title: "Desligadas", onTap: () => set("") }];
  for (const it of items) {
    opts.push({ on: !!cur && (cur === it.vssId || cur === it.lang), icon: ICON_CC, title: it.name, sub: it.auto ? "Geradas automaticamente" : "", onTap: () => set(it.vssId) });
  }
  $("ccList").replaceChildren(...opts.map(tabOpt));
}

// Velocidade: carrossel com as mesmas da extensão (0,25× a 5×); a escolhida desliza para o meio
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5];
let shownRate = 0;
function buildRates() {
  $("rateSeg").replaceChildren(...RATES.map((r) => {
    const b = document.createElement("button");
    b.dataset.rate = r;
    b.setAttribute("role", "radio");
    b.textContent = `${String(r).replace(".", ",")}×`;
    return b;
  }));
}
function markRate(instant) {
  const rate = st.rate || 1;
  let on = null;
  for (const b of $("rateSeg").children) {
    const hit = Math.abs(Number(b.dataset.rate) - rate) < 0.01;
    b.classList.toggle("on", hit);
    b.setAttribute("aria-checked", String(hit));
    if (hit) on = b;
  }
  if (on && shownRate !== rate) {
    shownRate = rate;
    const box = $("rateSeg");
    box.scrollTo({ left: on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2, behavior: instant ? "instant" : "smooth" });
  }
}

// Tempo andando entre uma atualização e outra
function curTime() {
  let t = st.time || 0;
  if (st.state === 1 && !st.ad) t += (performance.now() - stAt) / 1000 * (st.rate || 1);
  return Math.min(t, st.duration || t);
}

function frame() {
  if (!seeking) {
    const t = curTime();
    $("tCur").textContent = fmt(t);
    const seek = $("seek");
    seek.value = st.duration ? Math.round(t / st.duration * 1000) : 0;
    setFill(seek);
  }
  if (st.sleep) sleepTick();
  if ($("chapSheet").open) markChapter(true);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------------------------
// Listas
// ---------------------------------------------------------------------------------------------
// Abas: Início (como a Home do PC: faixas Assistir mais tarde e Inscrições em carrossel, na ordem e
// com as linhas escolhidas lá, e os Recomendados com os filtros), Fila e Buscar.
// Toque toca no PC; segurar abre o menu do vídeo (fila, Assistir mais tarde, compartilhar).
let tab = "home";
let lastQuery = "";
let home = null;        // { sections, chips, chip, def, items, cont }
let recsLoading = false;
let recsObserver = null;

const svgIcon = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICONS = {
  play: "M8 5v14l11-7z",
  queue: "M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14 0v-4h2v4h4v2h-4v4h-2v-4h-4v-2z",
  wl: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z",
  wlOff: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-1.2-5.6L7.6 11.2 6.2 12.6l4.6 4.6 7-7-1.4-1.4z",
  remove: "m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z",
  share: "M18 16.1c-.8 0-1.4.3-2 .8l-7.1-4.2c.1-.2.1-.5.1-.7s0-.5-.1-.7L16 7.2c.5.5 1.2.8 2 .8a3 3 0 1 0-3-3c0 .2 0 .5.1.7L8 9.8A3 3 0 1 0 8 14.2l7.1 4.2c-.1.2-.1.4-.1.6a2.9 2.9 0 1 0 3-2.9z",
  yt: "M10 15l5.2-3L10 9v6zm11.6-7.8c.4 1.4.4 4.8.4 4.8s0 3.4-.4 4.8a2.5 2.5 0 0 1-1.8 1.8C18.4 19 12 19 12 19s-6.4 0-7.8-.4a2.5 2.5 0 0 1-1.8-1.8C2 15.4 2 12 2 12s0-3.4.4-4.8a2.5 2.5 0 0 1 1.8-1.8C5.6 5 12 5 12 5s6.4 0 7.8.4a2.5 2.5 0 0 1 1.8 1.8z"
};

// Segurar ~0,45 s abre o menu; o card afunda enquanto segura (e volta se soltar antes)
function holdable(row, onHold) {
  let timer = 0, sx = 0, sy = 0, held = false;
  const cancel = () => { clearTimeout(timer); row.classList.remove("press"); };
  row.addEventListener("pointerdown", (e) => {
    held = false;
    sx = e.clientX; sy = e.clientY;
    row.classList.add("press");
    timer = setTimeout(() => {
      held = true;
      row.classList.remove("press");
      if (navigator.vibrate) navigator.vibrate(15);
      onHold();
    }, 450);
  });
  row.addEventListener("pointermove", (e) => { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel(); });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) row.addEventListener(t, cancel);
  row.addEventListener("contextmenu", (e) => e.preventDefault());
  row.addEventListener("click", (e) => {
    if (held) { e.preventDefault(); e.stopImmediatePropagation(); held = false; }
  }, true);
}

function itemEl(v, i, { current, onTap, menu }) {
  const row = document.createElement("div");
  row.className = "item" + (current ? " current" : "");
  row.dataset.id = v.videoId;
  row.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
  const pic = document.createElement("div");
  pic.className = "pic";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = "";
  img.draggable = false;
  img.src = thumbUrl(v.videoId);
  pic.append(img);
  if (v.duration || v.isLive) {
    const d = document.createElement("span");
    d.className = "dur" + (v.isLive ? " live" : "");
    d.textContent = v.isLive ? "AO VIVO" : v.duration;
    pic.append(d);
  }
  const txt = document.createElement("div");
  txt.className = "txt";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = v.title || v.videoId;
  const c = document.createElement("div");
  c.className = "c";
  c.textContent = [v.channel, v.info].filter(Boolean).join(" · ");
  txt.append(t, c);
  row.append(pic, txt);
  row.addEventListener("click", onTap);
  if (menu) holdable(row, () => openMenu(v, menu()));
  return row;
}

function emptyEl(text) {
  const e = document.createElement("div");
  e.className = "empty";
  e.textContent = text;
  return e;
}

const playOnPc = (v) => { send({ c: "open", videoId: v.videoId, title: v.title || "" }); toast("Tocando no PC"); };

// Opções do menu de um vídeo comum (Inscrições, Recomendados, Buscar); inWl: está no Assistir mais tarde
function videoMenu(v, inWl) {
  return [
    { icon: ICONS.play, text: "Tocar no PC", run: () => playOnPc(v) },
    { icon: ICONS.queue, text: "Adicionar à fila", run: () => send({ c: "queue", videoId: v.videoId }) },
    inWl
      ? { icon: ICONS.wlOff, text: "Tirar do Assistir mais tarde", run: () => send({ c: "wl", videoId: v.videoId, on: false }) }
      : { icon: ICONS.wl, text: "Salvar em Assistir mais tarde", run: () => send({ c: "wl", videoId: v.videoId, on: true }) },
    { icon: ICONS.share, text: "Compartilhar", run: () => shareVideo(v) },
    { icon: ICONS.yt, text: "Abrir no app do YouTube", run: () => { location.href = `https://youtu.be/${v.videoId}`; } }
  ];
}

async function shareVideo(v) {
  const url = `https://youtu.be/${v.videoId}`;
  try {
    if (navigator.share) await navigator.share({ title: v.title || "", url });
    else { await navigator.clipboard.writeText(url); toast("Link copiado"); }
  } catch (err) {}
}

let lastMenuVideo = null;
function openMenu(v, opts) {
  lastMenuVideo = v;
  const sheet = $("vidSheet");
  $("vidThumb").src = thumbUrl(v.videoId);
  $("vidTitle").textContent = v.title || v.videoId;
  $("vidChannel").textContent = v.channel || "";
  $("vidOpts").replaceChildren(...opts.map((o, i) => {
    const b = document.createElement("button");
    b.className = "menu-opt";
    b.style.animationDelay = `${i * 30}ms`;
    b.innerHTML = svgIcon(o.icon);
    const s = document.createElement("span");
    s.textContent = o.text;
    b.append(s);
    b.addEventListener("click", () => { sheet.close(); o.run(); });
    return b;
  }));
  sheet.showModal();
}

const listItemEl = (v, i) => itemEl(v, i, { current: v.videoId === st.videoId, onTap: () => playOnPc(v), menu: () => videoMenu(v, false) });

// Atualiza uma lista sem piscar: os que já estavam ficam (sem repetir a entrada), os que saíram
// fecham e os novos entram abrindo espaço, com um brilho amarelo
function syncRows(box, items, make) {
  const old = new Map([...box.querySelectorAll(".item[data-id]")].map((r) => [r.dataset.id, r]));
  const keep = new Set(items.map((v) => v.videoId));
  for (const [id, r] of old) {
    if (keep.has(id)) continue;
    old.delete(id);
    r.removeAttribute("data-id");
    r.style.animation = "";
    r.classList.add("leaving");
    setTimeout(() => r.remove(), 450);
  }
  for (const e of box.querySelectorAll(".empty")) e.remove();
  let at = box.firstElementChild;
  items.forEach((v, i) => {
    let row = old.get(v.videoId);
    if (!row) {
      row = make(v, i);
      row.classList.add("fresh");
    } else {
      row.style.animation = "none";
    }
    if (row !== at) box.insertBefore(row, at);
    else at = at.nextElementSibling;
  });
}

function renderList(items, error, auto) {
  const list = $("list");
  if (auto && error) return;
  if (error) return list.replaceChildren(emptyEl(`Não deu para carregar: ${error}`));
  if (!items?.length) return list.replaceChildren(emptyEl(tab === "search" && !lastQuery ? "Digite o que procurar" : "Nada aqui"));
  if (!auto || !list.querySelector(".item")) return list.replaceChildren(...items.map(listItemEl));
  syncRows(list, items, listItemEl);
}

function renderQueue() {
  const list = $("list");
  if (!queue.items?.length) return list.replaceChildren(emptyEl("A fila do YouTube está vazia. Segure um vídeo e escolha \"Adicionar à fila\"."));
  list.replaceChildren(...queue.items.map((v, i) => itemEl(v, i, {
    current: i === queue.cur,
    onTap: () => send({ c: "queuePlay", setId: v.setId, videoId: v.videoId }),
    menu: () => [
      { icon: ICONS.play, text: "Tocar agora", run: () => send({ c: "queuePlay", setId: v.setId, videoId: v.videoId }) },
      { icon: ICONS.remove, text: "Tirar da fila", run: () => send({ c: "queueRemove", setId: v.setId }) },
      { icon: ICONS.share, text: "Compartilhar", run: () => shareVideo(v) }
    ]
  })));
}

// ---------------------------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------------------------
function shelfItemEl(key) {
  return (v, i) => itemEl(v, i, {
    current: v.videoId === st.videoId,
    onTap: () => playOnPc(v),
    menu: () => videoMenu(v, key === "wl")
  });
}

function shelfEl(s) {
  const sec = document.createElement("section");
  sec.className = "shelf";
  sec.dataset.key = s.key;
  const h = document.createElement("h3");
  h.className = "shelf-h";
  h.textContent = s.title;
  const n = document.createElement("span");
  n.className = "n";
  n.textContent = s.items.length ? String(s.items.length) : "";
  h.append(n);
  const rail = document.createElement("div");
  rail.className = "rail";
  rail.dataset.key = s.key;
  rail.style.setProperty("--rows", Math.min(s.rows, Math.max(1, s.items.length)));
  const make = shelfItemEl(s.key);
  if (s.items.length) rail.append(...s.items.map(make));
  else rail.append(emptyEl("Nada aqui"));
  sec.append(h, rail);
  return sec;
}

function renderHome() {
  const list = $("list");
  if (!home) return list.replaceChildren(emptyEl("Carregando…"));
  const parts = [];
  for (const s of home.sections) parts.push(shelfEl(s));
  const rh = document.createElement("h3");
  rh.className = "shelf-h";
  rh.textContent = "Recomendados";
  parts.push(rh);
  if (home.chips.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    chips.id = "chips";
    home.chips.forEach((text, i) => {
      const b = document.createElement("button");
      b.className = i === home.chip ? "on" : "";
      b.textContent = text;
      if (i === home.def && home.def !== 0) {
        const d = document.createElement("span");
        d.className = "def";
        d.textContent = "· Padrão";
        b.append(d);
      }
      b.addEventListener("click", () => pickChip(i));
      chips.append(b);
    });
    parts.push(chips);
  }
  const recs = document.createElement("div");
  recs.className = "list recs";
  recs.id = "recs";
  if (home.error && !home.items.length) recs.append(emptyEl(`Não deu para carregar: ${home.error}`));
  else if (home.items.length) recs.append(...home.items.map(listItemEl));
  else recs.append(emptyEl("Nada aqui"));
  const more = document.createElement("div");
  more.className = "more";
  more.id = "recsMore";
  parts.push(recs, more);
  list.replaceChildren(...parts);
  centerChip(false);
  watchMore();
}

// O filtro escolhido fica no meio do carrossel de filtros
function centerChip(smooth) {
  const bar = $("chips");
  const on = bar?.querySelector(".on");
  if (!on) return;
  const left = on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2;
  bar.scrollTo({ left: Math.max(0, left), behavior: smooth ? "smooth" : "instant" });
}

function pickChip(i) {
  if (!home || recsLoading) return;
  home.chip = i;
  for (const [j, b] of [...$("chips").children].entries()) b.classList.toggle("on", j === i);
  centerChip(true);
  recsLoading = true;
  $("recs").classList.add("loading");
  send({ c: "recs", chip: i });
}

function watchMore() {
  recsObserver?.disconnect();
  const more = $("recsMore");
  if (!more) return;
  recsObserver = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting) || !home?.cont || recsLoading || tab !== "home") return;
    recsLoading = true;
    more.classList.add("on");
    send({ c: "recs", chip: home.chip, cont: home.cont });
  }, { rootMargin: "600px 0px" });
  recsObserver.observe(more);
}

function onRecs(m) {
  recsLoading = false;
  if (!home || tab !== "home") return;
  $("recsMore")?.classList.remove("on");
  const recs = $("recs");
  if (!recs) return;
  if (m.append) {
    const shown = new Set(home.items.map((v) => v.videoId));
    const fresh = (m.items || []).filter((v) => !shown.has(v.videoId));
    home.items = home.items.concat(fresh);
    home.cont = m.cont || "";
    recs.append(...fresh.map(listItemEl));
    return;
  }
  if (m.chip !== home.chip) return;
  recs.classList.remove("loading");
  if (m.error) { toast("Não deu para carregar esse filtro"); return; }
  home.items = m.items || [];
  home.cont = m.cont || "";
  recs.replaceChildren(...(home.items.length ? home.items.map(listItemEl) : [emptyEl("Nada aqui")]));
}

// Inscrições mudaram no PC: o carrossel delas no Início se atualiza sozinho
function onSubsAuto(items) {
  const s = home?.sections.find((x) => x.key === "subs");
  if (!s) return;
  s.items = items;
  const rail = document.querySelector('.rail[data-key="subs"]');
  if (!rail || tab !== "home") return;
  rail.style.setProperty("--rows", Math.min(s.rows, Math.max(1, items.length)));
  syncRows(rail, items, shelfItemEl("subs"));
  const n = rail.parentElement.querySelector(".n");
  if (n) n.textContent = String(items.length);
}

// Tirado do Assistir mais tarde: sai do carrossel dele fechando o espaço
// Assistir mais tarde mudou pelo celular: o vídeo entra na frente (ou sai) na hora, e a lista de
// verdade chega logo depois (wlList)
const knownVideo = (id) => [...(home?.sections.flatMap((x) => x.items) || []), ...(home?.items || []), ...(lastMenuVideo ? [lastMenuVideo] : [])]
  .find((v) => v.videoId === id);

// Mudanças feitas pelo celular valem por 1 min por cima da lista lida no PC (a página do Assistir
// mais tarde pode demorar a mostrar o vídeo novo, ou só trazer os primeiros ~100)
const wlEdits = new Map(); // videoId → { on, v, at }
function withWlEdits(items) {
  const now = Date.now();
  let out = items.slice();
  for (const [id, e] of wlEdits) {
    if (now - e.at > 60000) { wlEdits.delete(id); continue; }
    if (e.on && e.v && !out.some((x) => x.videoId === id)) out.unshift(e.v);
    if (!e.on) out = out.filter((x) => x.videoId !== id);
  }
  return out;
}

function onWlChanged(m) {
  if (!home) return;
  wlEdits.set(m.videoId, { on: !!m.on, v: knownVideo(m.videoId), at: Date.now() });
  const s = home.sections.find((x) => x.key === "wl");
  if (m.on) {
    const v = knownVideo(m.videoId);
    if (v && (!s || !s.items.some((x) => x.videoId === v.videoId))) setWlItems([v, ...(s?.items || [])]);
    return;
  }
  if (s) setWlItems(s.items.filter((v) => v.videoId !== m.videoId));
}

// Troca os vídeos da faixa Assistir mais tarde sem piscar; sem vídeos ela some, e volta no lugar
// dela (wlSlot: posição na ordem da Home do PC) quando ganha um
function setWlItems(items) {
  if (!home) return;
  let s = home.sections.find((x) => x.key === "wl");
  if (!s) {
    if (!items.length || !(home.wlSlot >= 0)) return;
    s = { key: "wl", title: "Assistir mais tarde", rows: home.wlRows || 1, items: [] };
    home.sections.splice(Math.min(home.wlSlot, home.sections.length), 0, s);
  }
  s.items = items;
  if (tab !== "home") return;
  let sec = document.querySelector('.shelf[data-key="wl"]');
  if (!items.length) {
    home.sections = home.sections.filter((x) => x !== s);
    if (sec) { sec.classList.add("leaving"); setTimeout(() => sec.remove(), 450); }
    return;
  }
  if (!sec) {
    sec = shelfEl(s);
    sec.classList.add("fresh");
    const next = home.sections[home.sections.indexOf(s) + 1];
    const before = next ? document.querySelector(`.shelf[data-key="${next.key}"]`) : $("list").querySelector(":scope > .shelf-h");
    $("list").insertBefore(sec, before || $("list").firstChild);
    return;
  }
  const rail = sec.querySelector(".rail");
  rail.style.setProperty("--rows", Math.min(s.rows, Math.max(1, items.length)));
  syncRows(rail, items, shelfItemEl("wl"));
  sec.querySelector(".n").textContent = String(items.length);
}

function showTab(name, reload) {
  const changed = tab !== name;
  tab = name;
  try { localStorage.setItem("ytpf-remote-tab", name); } catch (err) {}
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  $("searchForm").hidden = name !== "search";
  if (name === "queue") return renderQueue();
  if (name === "home") {
    if (reload || !home) {
      if (!home) $("list").replaceChildren(emptyEl("Carregando…"));
      recsLoading = false;
      send({ c: "home" });
    }
    if (changed && home) renderHome();
    return;
  }
  if (name === "search" && !lastQuery) return renderList([]);
  if (changed || reload) {
    $("list").replaceChildren(emptyEl("Carregando…"));
    send({ c: "list", which: name, q: name === "search" ? lastQuery : "" });
  }
}

// ---------------------------------------------------------------------------------------------
// Abas do PC
// ---------------------------------------------------------------------------------------------
const ICON_FOCUS = '<svg viewBox="0 0 24 24"><path d="M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6zm9 14H6V10h12v10z"/></svg>';

const ICON_OFF = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A7.9 7.9 0 0 1 4 12zm8 8a7.9 7.9 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24"><path d="M12.3 2C6.6 1.8 2 6.4 2 12a10 10 0 0 0 18.7 5C13.1 16.7 8.5 8.5 12.3 2z"/></svg>';
const ICON_END = '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
const ICON_CC = '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z"/></svg>';

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function tabOpt({ on, icon, title, sub, tags, onTap }, i) {
  const b = document.createElement("button");
  b.className = "tab-opt" + (on ? " on" : "");
  b.style.animationDelay = `${i * 30}ms`;
  const ico = document.createElement("span");
  ico.className = "ico";
  ico.innerHTML = icon;
  const txt = document.createElement("span");
  txt.className = "txt";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = title;
  txt.append(t);
  if (sub) {
    const c = document.createElement("div");
    c.className = "c";
    c.textContent = sub;
    txt.append(c);
  }
  if (tags?.length) {
    const row = document.createElement("div");
    row.className = "tags";
    for (const [text, hot] of tags) {
      const g = document.createElement("span");
      g.className = "tag" + (hot ? " hot" : "");
      g.textContent = text;
      row.append(g);
    }
    txt.append(row);
  }
  b.append(ico, txt);
  b.addEventListener("click", onTap);
  return b;
}

function pinTab(tabId) {
  send({ c: "pin", tabId });
  $("tabSheet").close();
}

function renderTabs(items, pin) {
  const list = $("tabList");
  const opts = [{
    on: !pin,
    icon: ICON_FOCUS,
    title: "Aba em foco",
    sub: "Padrão: toca na aba do YouTube que estiver em foco no PC",
    onTap: () => pinTab(0)
  }];
  for (const it of items) {
    const tags = [];
    if (it.playing) tags.push(["Tocando", true]);
    if (it.pip) tags.push(["Janela flutuante", true]);
    if (it.focused) tags.push(["Em foco", false]);
    if (it.serving) tags.push(["Atende o celular", false]);
    opts.push({
      on: it.tabId === pin,
      icon: ICON_PIN,
      title: it.title,
      sub: [it.kind !== it.title ? it.kind : "", it.monitor, it.window, it.tab].filter(Boolean).join(" · "),
      tags,
      onTap: () => pinTab(it.tabId)
    });
  }
  if (!items.length) {
    const e = emptyEl("Nenhuma aba do YouTube respondeu");
    list.replaceChildren(...opts.map(tabOpt), e);
  } else {
    list.replaceChildren(...opts.map(tabOpt));
  }
}

// ---------------------------------------------------------------------------------------------
// Aviso
// ---------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1800);
}

// ---------------------------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------------------------
function bindUi() {
  document.querySelectorAll(".controls .ctl").forEach((b) => b.addEventListener("click", () => {
    const cmd = b.dataset.cmd;
    if (navigator.vibrate) navigator.vibrate(10);
    if (cmd === "back" || cmd === "fwd") send({ c: "skip", by: cmd === "back" ? -10 : 10 });
    else {
      if (cmd === "toggle") { st.time = curTime(); stAt = performance.now(); st.state = st.state === 1 ? 2 : 1; renderNow(); }
      send({ c: cmd });
    }
  }));
  const seek = $("seek");
  seek.addEventListener("input", () => {
    seeking = true;
    setFill(seek);
    $("tCur").textContent = fmt(seek.value / 1000 * (st.duration || 0));
  });
  seek.addEventListener("change", () => {
    const time = seek.value / 1000 * (st.duration || 0);
    send({ c: "seek", time });
    st.time = time;
    stAt = performance.now();
    seeking = false;
  });
  const vol = $("vol");
  vol.addEventListener("input", () => {
    volDragging = true;
    setFill(vol);
    send({ c: "volume", level: Number(vol.value) });
  });
  vol.addEventListener("change", () => { volDragging = false; });
  $("btnMute").addEventListener("click", () => send({ c: "mute", on: !(st.muted || st.volume === 0) }));
  $("btnTarget").addEventListener("click", () => {
    $("tabList").replaceChildren(emptyEl("Procurando as abas do PC…"));
    $("tabSheet").showModal();
    send({ c: "tabs" });
  });
  // Toque fora da folha fecha
  for (const id of ["tabSheet", "vidSheet", "sleepSheet", "chapSheet", "ccSheet"]) $(id).addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  // Ações do vídeo atual
  const buzz = () => { if (navigator.vibrate) navigator.vibrate(10); };
  $("btnLike").addEventListener("click", () => {
    if (!st.videoId) return;
    buzz();
    hold("liked", !st.liked);
    send({ c: "like", videoId: st.videoId, on: st.liked });
    renderNow();
  });
  $("btnWl").addEventListener("click", () => {
    if (!st.videoId) return;
    buzz();
    hold("inWl", !st.inWl);
    send({ c: "wl", videoId: st.videoId, on: st.inWl });
    renderNow();
  });
  $("btnChap").addEventListener("click", () => {
    $("chapList").replaceChildren(emptyEl("Carregando os capítulos…"));
    chapters = [];
    $("chapSheet").showModal();
    send({ c: "chapters" });
  });
  $("btnCc").addEventListener("click", () => {
    $("ccList").replaceChildren(emptyEl("Procurando as legendas…"));
    $("ccSheet").showModal();
    send({ c: "captions" });
  });
  $("btnSleep").addEventListener("click", () => {
    renderSleep();
    $("sleepSheet").showModal();
  });
  $("btnFs").addEventListener("click", () => {
    st.fs = !st.fs;
    send({ c: "fs", on: st.fs });
    renderNow();
    toast(st.fs ? "Tela cheia no PC" : "Saindo da tela cheia");
  });
  $("rateSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { send({ c: "rate", rate: Number(b.dataset.rate) }); st.rate = Number(b.dataset.rate); renderNow(); }
  });
  $("resSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { send({ c: "res", mode: b.dataset.res }); st.resMode = b.dataset.res; renderNow(); }
  });
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) showTab(b.dataset.tab, b.dataset.tab === tab);
  });
  $("searchForm").addEventListener("submit", (e) => {
    e.preventDefault();
    lastQuery = $("searchInput").value.trim();
    $("searchInput").blur();
    showTab("search", true);
  });
}

async function main() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const secret = readKey();
  if (!secret) {
    $("pairView").hidden = false;
    return;
  }
  $("mainView").hidden = false;
  try { tab = localStorage.getItem("ytpf-remote-tab") || "home"; } catch (err) {}
  if (!["home", "queue"].includes(tab)) tab = "home";
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === tab);
  buildRates();
  bindUi();
  renderNow();
  renderDiag();
  markRate(true);
  requestAnimationFrame(frame);
  try { identity = await loadIdentity(); } catch (err) {}
  renderPairCard();
  $("btnScanPc").addEventListener("click", scanPcQr);
  $("btnScanClose").addEventListener("click", stopScan);
  $("btnScanSwitch").addEventListener("click", async () => {
    $("scanMsg").textContent = "Trocando de câmera…";
    await openCamera(1);
    $("scanMsg").textContent = "Aponte para o QR de conexão no PC";
  });
  $("scanSheet").addEventListener("close", stopScan);
  $("btnPairHide").addEventListener("click", () => { $("pairCard").hidden = true; });
  // Mostrar o QR de pareamento a qualquer hora (pelo botão sem conexão, ou tocando na versão)
  const showPair = () => { renderPairCard(); $("pairCard").hidden = false; window.scrollTo({ top: 0, behavior: "smooth" }); };
  $("btnShowPair").addEventListener("click", showPair);
  $("pcVer").addEventListener("click", () => { if ($("pairCard").hidden) showPair(); else $("pairCard").hidden = true; });
  window.connectByInvite = connectByInvite; // testes
  ctx = await keys(secret);
  connect();
}

main();
