/**
 * Controle remoto da YTPowerFeed (página do celular).
 * Conversa direto com a aba do YouTube no PC (content/remote.js da extensão) por WebRTC. A oferta e a
 * resposta passam por um tópico do ntfy.sh, criptografadas com a chave do QR code (AES-GCM); o tópico
 * sai da própria chave (SHA-256). A chave vem no "#k=" do link e fica guardada neste aparelho.
 */

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
    await fetch(`${RELAY}/${ctx.topic}?cache=no`, {
      method: "POST",
      body: JSON.stringify({ f: me, i: id, p, n, d: data.slice(p * CHUNK, (p + 1) * CHUNK) })
    });
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
let pc = null;
let dc = null;
let waiting = null;   // resolve da resposta esperada
let connecting = false;
let retryTimer = 0;
let fails = 0;

function setConn(state, text) {
  $("conn").dataset.state = state;
  $("connText").textContent = text;
}

function listenRelay() {
  es?.close();
  es = new EventSource(`${RELAY}/${ctx.topic}/sse`);
  es.onmessage = async (e) => {
    try {
      const env = JSON.parse(JSON.parse(e.data).message || "null");
      if (!env || env.f === me || typeof env.d !== "string") return;
      const text = reassemble(env);
      if (!text) return;
      const msg = await unseal(ctx.key, text);
      if (msg.type === "answer" && msg.to === me && waiting) waiting(msg);
    } catch (err) {}
  };
  return new Promise((resolve) => {
    es.onopen = () => resolve();
    setTimeout(resolve, 4000);
  });
}

function iceDone(peer) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
}

async function connect() {
  if (connecting || dc?.readyState === "open") return;
  connecting = true;
  clearTimeout(retryTimer);
  setConn("wait", "Procurando o PC…");
  try {
    if (!es || es.readyState === EventSource.CLOSED) await listenRelay();
    try { pc?.close(); } catch (err) {}
    pc = new RTCPeerConnection({ iceServers: ICE });
    dc = pc.createDataChannel("ytpf");
    dc.onopen = () => {
      fails = 0;
      setConn("on", "Conectado");
      send({ c: "hello", name: deviceName() });
      showTab(tab, true);
    };
    dc.onclose = () => { setConn("off", "Desconectado"); scheduleRetry(); };
    dc.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) {} };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") { setConn("off", "A conexão caiu"); scheduleRetry(); }
    };
    await pc.setLocalDescription(await pc.createOffer());
    await iceDone(pc);
    const answer = new Promise((resolve, reject) => {
      waiting = resolve;
      setTimeout(() => reject(new Error("sem resposta")), 9000);
    });
    await publish(ctx, { type: "offer", sdp: pc.localDescription.sdp, name: deviceName() });
    const msg = await answer;
    waiting = null;
    await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    // Conectando: o onopen do canal confirma
    setTimeout(() => { if (dc?.readyState !== "open") scheduleRetry(); }, 10000);
  } catch (err) {
    waiting = null;
    fails++;
    setConn("off", fails > 1 ? "PC não encontrado. Abra o YouTube no PC" : "Procurando o PC…");
    scheduleRetry();
  } finally {
    connecting = false;
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  if (document.hidden) return;
  retryTimer = setTimeout(connect, Math.min(15000, 2000 + fails * 2000));
}

function send(obj) {
  if (dc?.readyState === "open") dc.send(JSON.stringify(obj));
  else connect();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && ctx && dc?.readyState !== "open") connect();
});

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
    st = m;
    stAt = performance.now();
    if (m.queue) { queue = m.queue; if (tab === "queue") renderQueue(); }
    renderNow();
  } else if (m.t === "list") {
    if (m.which === tab && (tab !== "search" || m.q === lastQuery)) renderList(m.items, m.error, !!m.auto);
  } else if (m.t === "toast") {
    toast(m.text);
  }
}

function renderNow() {
  const has = !!st.videoId;
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
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------------------------
// Listas
// ---------------------------------------------------------------------------------------------
let tab = "subs";
let lastQuery = "";
const ICON_QUEUE = '<svg viewBox="0 0 24 24"><path d="M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14 0v-4h2v4h4v2h-4v4h-2v-4h-4v-2z"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 24 24"><path d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>';

function itemEl(v, i, { current, action, onTap, onAct }) {
  const row = document.createElement("div");
  row.className = "item" + (current ? " current" : "");
  row.dataset.id = v.videoId;
  row.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
  const pic = document.createElement("div");
  pic.className = "pic";
  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = "";
  img.src = thumbUrl(v.videoId);
  pic.append(img);
  if (v.duration || v.isLive) {
    const d = document.createElement("span");
    d.className = "dur" + (v.isLive ? " live" : "");
    d.textContent = v.isLive ? "AO VIVO" : v.duration;
    pic.append(d);
  }
  const txt = document.createElement("div");
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = v.title || v.videoId;
  const c = document.createElement("div");
  c.className = "c";
  c.textContent = [v.channel, v.info].filter(Boolean).join(" · ");
  txt.append(t, c);
  const act = document.createElement("button");
  act.className = "act";
  act.setAttribute("aria-label", action === "remove" ? "Tirar da fila" : "Adicionar à fila");
  act.innerHTML = action === "remove" ? ICON_REMOVE : ICON_QUEUE;
  act.addEventListener("click", (e) => { e.stopPropagation(); onAct(); });
  row.append(pic, txt, act);
  row.addEventListener("click", onTap);
  return row;
}

function emptyEl(text) {
  const e = document.createElement("div");
  e.className = "empty";
  e.textContent = text;
  return e;
}

function listItemEl(v, i) {
  return itemEl(v, i, {
    current: v.videoId === st.videoId,
    action: "queue",
    onTap: () => { send({ c: "open", videoId: v.videoId, title: v.title || "" }); toast("Tocando no PC"); },
    onAct: () => send({ c: "queue", videoId: v.videoId })
  });
}

// auto: a lista mudou sozinha no PC (vídeo novo nas Inscrições). Os que já estavam ficam onde
// estão, sem piscar; os novos entram abrindo espaço, com um brilho amarelo
function renderList(items, error, auto) {
  const list = $("list");
  if (auto && error) return;
  if (error) return list.replaceChildren(emptyEl(`Não deu para carregar: ${error}`));
  if (!items?.length) return list.replaceChildren(emptyEl(tab === "search" && !lastQuery ? "Digite o que procurar" : "Nada aqui"));
  const old = new Map([...list.querySelectorAll(".item[data-id]")].map((r) => [r.dataset.id, r]));
  if (!auto || !old.size) return list.replaceChildren(...items.map(listItemEl));
  const keep = new Set(items.map((v) => v.videoId));
  for (const [id, r] of old) if (!keep.has(id)) r.remove();
  for (const e of list.querySelectorAll(".empty")) e.remove();
  let at = list.firstElementChild;
  items.forEach((v, i) => {
    let row = old.get(v.videoId);
    if (!row) {
      row = listItemEl(v, 0);
      row.classList.add("fresh");
    } else {
      row.style.animation = "none"; // mudar de lugar não repete a entrada
    }
    if (row !== at) list.insertBefore(row, at);
    else at = at.nextElementSibling;
  });
}

function renderQueue() {
  const list = $("list");
  if (!queue.items?.length) return list.replaceChildren(emptyEl("A fila do YouTube está vazia. Use o + de um vídeo para pôr nela."));
  list.replaceChildren(...queue.items.map((v, i) => itemEl(v, i, {
    current: i === queue.cur,
    action: "remove",
    onTap: () => send({ c: "queuePlay", setId: v.setId, videoId: v.videoId }),
    onAct: () => send({ c: "queueRemove", setId: v.setId })
  })));
}

function showTab(name, reload) {
  const changed = tab !== name;
  tab = name;
  try { localStorage.setItem("ytpf-remote-tab", name); } catch (err) {}
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === name);
  $("searchForm").hidden = name !== "search";
  if (name === "queue") return renderQueue();
  if (name === "search" && !lastQuery) return renderList([]);
  if (changed || reload) {
    $("list").replaceChildren(emptyEl("Carregando…"));
    send({ c: "list", which: name, q: name === "search" ? lastQuery : "" });
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
  try { tab = localStorage.getItem("ytpf-remote-tab") || "subs"; } catch (err) {}
  if (tab === "search") tab = "subs";
  for (const b of $("tabs").children) b.classList.toggle("on", b.dataset.tab === tab);
  buildRates();
  bindUi();
  renderNow();
  markRate(true);
  requestAnimationFrame(frame);
  ctx = await keys(secret);
  connect();
}

main();
