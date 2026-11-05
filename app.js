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

// Celular trancado: o sistema congela a página e a conexão morre sem avisar (o canal continua
// "aberto" por um tempo). Ao voltar, e a cada poucos segundos sem notícia do PC, o celular manda
// um "ping"; sem resposta em 2 s, a conexão é dada como morta e ele procura o PC de novo, sozinho
let lastMsgAt = 0;
let connectingAt = 0;
let pingTimer = 0;

function dropConnection() {
  try { dc?.close(); } catch (err) {}
  try { pc?.close(); } catch (err) {}
  dc = null;
  pc = null;
}

function check(force) {
  if (!ctx || document.hidden || connecting && Date.now() - connectingAt < 20000) return;
  if (dc?.readyState !== "open") { fails = 0; connect(); return; }
  if (pingTimer || (!force && Date.now() - lastMsgAt < 3000)) return;
  const sentAt = Date.now();
  try { dc.send(JSON.stringify({ c: "ping" })); } catch (err) {}
  pingTimer = setTimeout(() => {
    pingTimer = 0;
    if (lastMsgAt >= sentAt || document.hidden) return;
    setConn("wait", "Reconectando…");
    dropConnection();
    fails = 0;
    connect();
  }, 2000);
}
const wake = () => check(true);

async function connect() {
  // Um pedido que ficou parado com a página congelada não segura os próximos
  if (connecting && Date.now() - connectingAt < 20000) return;
  if (dc?.readyState === "open") return;
  connecting = true;
  connectingAt = Date.now();
  clearTimeout(retryTimer);
  setConn("wait", "Procurando o PC…");
  try {
    if (!es || es.readyState === EventSource.CLOSED) await listenRelay();
    try { pc?.close(); } catch (err) {}
    pc = new RTCPeerConnection({ iceServers: ICE });
    dc = pc.createDataChannel("ytpf");
    dc.onopen = () => {
      fails = 0;
      lastMsgAt = Date.now();
      setConn("on", "Conectado");
      send({ c: "hello", name: deviceName() });
      showTab(tab, true);
    };
    const mine = dc;
    dc.onclose = () => { if (dc !== mine && dc) return; setConn("off", "Desconectado"); scheduleRetry(); };
    dc.onmessage = (e) => { lastMsgAt = Date.now(); try { onMessage(JSON.parse(e.data)); } catch (err) {} };
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
    setTimeout(() => { if (dc === mine && dc.readyState !== "open") scheduleRetry(); }, 10000);
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
  if (dc?.readyState === "open") { dc.send(JSON.stringify(obj)); check(false); }
  else wake();
}

// Ao destravar o celular ou voltar para a página: confere a conexão e, morta, procura o PC
document.addEventListener("visibilitychange", wake);
window.addEventListener("pageshow", wake);
window.addEventListener("online", wake);
window.addEventListener("focus", wake);
// Com a página à vista: conexão parada (sem notícia do PC) volta sozinha
setInterval(() => check(false), 3000);

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
  } else if (m.t === "toast") {
    toast(m.text);
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
  for (const id of ["tabSheet", "vidSheet"]) $(id).addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
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
  markRate(true);
  requestAnimationFrame(frame);
  ctx = await keys(secret);
  connect();
}

main();
