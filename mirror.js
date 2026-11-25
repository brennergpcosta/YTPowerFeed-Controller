/**
 * Espelho: tocar na capa do "Tocando agora" passa aqui o vídeo que toca no PC. O vídeo vem do
 * próprio PC, pela conexão direta com ele na rede de casa (WebRTC, sem servidor e sem internet),
 * em qualidade baixa (até 480p). Mudo por padrão, com botão de som. Tocar de novo na capa fecha.
 * Protocolo: o celular pede { c: "mirror", on }; na primeira vez em cada conexão o PC manda uma
 * oferta { t: "rtc", sdp } com as trilhas e o celular responde { c: "rtcAnswer", sdp }.
 */

const $ = (id) => document.getElementById(id);
let on = false, muted = true, msgTimer = 0, killTimer = 0, watchTimer = 0, logged = false;
let ctx = { send: () => {}, pc: () => null, state: () => ({}), diag: () => {} };
const wd = { frames: -1, since: 0, tries: 0 };

// Vigia: imagem parada por 3 s com o PC tocando → anota no diagnóstico e pede ao PC para capturar
// de novo (até 3 vezes seguidas)
async function watch() {
  const pc = ctx.pc();
  if (!on || document.hidden || !pc) return;
  let r = null;
  try { (await pc.getStats()).forEach((x) => { if (x.type === "inbound-rtp" && x.kind === "video") r = x; }); } catch (err) { return; }
  const f = r?.framesDecoded ?? 0, now = performance.now();
  if (f !== wd.frames) {
    if (f > wd.frames && wd.frames >= 0) wd.tries = 0;
    wd.frames = f;
    wd.since = now;
    if (f > 0 && !logged) { logged = true; ctx.diag(`Vídeo na capa chegando (${r.frameHeight || "?"}p)`, pc); }
    return;
  }
  const st = ctx.state();
  if (!(st.state === 1 && !st.ad) || now - wd.since < 3000 || wd.tries >= 3) return;
  wd.since = now;
  wd.tries++;
  const mx = st.mx || {};
  ctx.diag(`Vídeo na capa parou (${wd.tries}ª): recebidos ${r?.framesReceived ?? 0}, pacotes ${r?.packetsReceived ?? 0}; PC ${mx.vis || "?"}, quadros lá ${mx.dec ?? "?"}, trilhas ${mx.tracks ?? "?"}, envio ${mx.snd || "?"}`, pc);
  ctx.send({ c: "mirror", on: true, fresh: true });
}

const video = () => $("mirrorVideo");
function setLive(v) { $("mirror").classList.toggle("live", v); }

function showMsg(text) {
  const el = $("mirrorMsg");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { el.classList.remove("on"); close(); }, 3500);
}

function renderSnd() {
  $("mirrorSnd").classList.toggle("muted", muted);
  $("mirrorSnd").setAttribute("aria-label", muted ? "Ligar o som no celular" : "Tirar o som do celular");
  video().muted = muted;
}

// No 4G/5G a conexão pode não ser direta pela rede de casa: o espelho fica só no Wi-Fi
const onCellular = () => navigator.connection?.type === "cellular";

function open() {
  openBox();
  if (onCellular()) { showMsg("O vídeo no celular só funciona no Wi-Fi de casa"); return; }
  ctx.send({ c: "mirror", on: true });
}
function openBox() {
  on = true;
  clearTimeout(killTimer);
  $("thumbWrap").classList.add("mirroring");
  $("mirror").classList.add("on");
  wd.frames = -1; wd.tries = 0; wd.since = performance.now(); logged = false;
  clearInterval(watchTimer);
  watchTimer = setInterval(watch, 1000);
  const v = video();
  if (v.srcObject && v.paused) v.play().catch(() => {});
}

function close() {
  if (!on) return;
  on = false;
  clearInterval(watchTimer);
  ctx.send({ c: "mirror", on: false });
  $("thumbWrap").classList.remove("mirroring");
  $("mirror").classList.remove("on");
  // Some com a transição e só então para (reabrir antes disso continua de onde está)
  clearTimeout(killTimer);
  killTimer = setTimeout(() => { if (!on) { video().pause(); setLive(false); } }, 450);
}

// Trilhas do PC (pc.ontrack): um stream só, com vídeo e som
export function mirrorTrack(e) {
  const v = video();
  let stream = e.streams[0];
  if (!stream) {
    stream = v.srcObject instanceof MediaStream ? v.srcObject : new MediaStream();
    stream.addTrack(e.track);
  }
  if (v.srcObject !== stream) v.srcObject = stream;
  if (on) v.play().catch(() => {});
}

// Oferta do PC (primeira vez em cada conexão)
export async function mirrorOffer(sdp) {
  const pc = ctx.pc();
  if (!pc || typeof sdp !== "string") return;
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  ctx.send({ c: "rtcAnswer", sdp: pc.localDescription.sdp });
}

// Conexão nova (caiu e voltou): pede o vídeo de novo
export function mirrorReconnected() {
  setLive(false);
  if (on && !document.hidden) ctx.send({ c: "mirror", on: true });
}

// Sem vídeo no PC: fecha
export function mirrorSync(st) { if (on && !st.videoId) close(); }

export function initMirror(opts) {
  ctx = opts;
  const v = video();
  // Só aparece com imagem (antes disso fica a capa com o círculo de carregando)
  const shown = () => { if (on && v.videoWidth) setLive(true); };
  v.addEventListener("playing", shown);
  v.addEventListener("resize", shown);
  $("thumbWrap").addEventListener("click", () => {
    if (navigator.vibrate) navigator.vibrate(10);
    if (on) close(); else if (ctx.state().videoId) open();
  });
  $("mirrorSnd").addEventListener("click", (e) => {
    e.stopPropagation();
    muted = !muted;
    renderSnd();
    if (on && v.paused) v.play().catch(() => {});
  });
  // Tela apagada: o PC para de mandar o vídeo; ao voltar, manda de novo
  document.addEventListener("visibilitychange", () => {
    if (!on) return;
    ctx.send({ c: "mirror", on: !document.hidden });
    if (!document.hidden) v.play().catch(() => {});
  });
  renderSnd();
}
