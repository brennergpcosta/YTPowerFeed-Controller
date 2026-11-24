/**
 * Espelho: tocar na capa do "Tocando agora" passa o mesmo vídeo aqui no celular, acompanhando o PC.
 * É o player do YouTube embutido (IFrame API), mudo por padrão: o vídeo vem direto do YouTube (gasta
 * dados do celular), não é a tela do PC. A posição segue o tempo que o PC manda; diferença acima de
 * ~1 s (tocando) faz pular para o ponto do PC. Tocar de novo na capa fecha.
 */

const $ = (id) => document.getElementById(id);
let apiWait = null;
let on = false, player = null, ready = false, vid = "", muted = true;
let holdUntil = 0, timer = 0, killTimer = 0, msgTimer = 0;
let get = () => ({ st: {}, t: 0 });

function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiWait) return apiWait;
  apiWait = new Promise((ok, fail) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (typeof prev === "function") prev(); ok(window.YT); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { apiWait = null; s.remove(); fail(new Error("sem rede")); };
    document.head.appendChild(s);
  });
  return apiWait;
}

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
}

async function open() {
  const { st, t } = get();
  if (!st.videoId) return;
  on = true;
  clearTimeout(killTimer);
  $("thumbWrap").classList.add("mirroring");
  $("mirror").classList.add("on");
  timer = timer || setInterval(sync, 1000);
  if (player) { sync(); return; } // reaberto no meio da saída: o player ainda está lá
  let YT;
  try { YT = await loadApi(); } catch (err) { showMsg("Sem conexão com o YouTube"); return; }
  if (!on || player) return;
  const stage = document.createElement("div");
  $("mirrorStage").replaceChildren(stage);
  vid = st.videoId;
  ready = false;
  setLive(false);
  player = new YT.Player(stage, {
    videoId: vid,
    width: "100%",
    height: "100%",
    playerVars: {
      autoplay: 1, mute: 1, controls: 0, playsinline: 1, rel: 0, fs: 0, disablekb: 1,
      iv_load_policy: 3, cc_load_policy: 0, start: Math.floor(t), origin: location.origin
    },
    events: {
      onReady: () => {
        ready = true;
        if (muted) player.mute(); else { player.unMute(); player.setVolume(100); }
        holdUntil = 0;
        sync();
      },
      onStateChange: (e) => { if (e.data === 1) setLive(true); },
      onError: (e) => showMsg(e.data === 101 || e.data === 150
        ? "O dono deste vídeo não deixa ele tocar fora do YouTube"
        : "Não deu para tocar este vídeo aqui")
    }
  });
}

function close() {
  on = false;
  clearInterval(timer);
  timer = 0;
  $("thumbWrap").classList.remove("mirroring");
  $("mirror").classList.remove("on");
  try { player?.pauseVideo(); } catch (err) {}
  // Some com a transição e só então desmonta (reabrir antes disso aproveita o mesmo player)
  clearTimeout(killTimer);
  killTimer = setTimeout(() => {
    if (on) return;
    try { player?.destroy(); } catch (err) {}
    player = null;
    ready = false;
    vid = "";
    setLive(false);
    $("mirrorStage").replaceChildren();
  }, 450);
}

// Acompanha o PC: vídeo, tocar/pausar, velocidade e posição
export function mirrorSync() { if (on) sync(); }
function sync() {
  const { st, t } = get();
  if (!st.videoId) { close(); return; }
  if (!player || !ready) return;
  const now = performance.now();
  if (st.videoId !== vid) {
    vid = st.videoId;
    setLive(false);
    player.loadVideoById({ videoId: vid, startSeconds: t });
    holdUntil = now + 3000;
    return;
  }
  const ls = player.getPlayerState();
  if (document.hidden) { if (ls === 1 || ls === 3) player.pauseVideo(); return; } // tela apagada: não gasta dados
  if (st.state === 3) return; // PC carregando: espera ele decidir
  const playing = st.state === 1 && !st.ad;
  if (playing) { if (ls !== 1 && ls !== 3) player.playVideo(); }
  else if (ls === 1 || ls === 3) player.pauseVideo();
  const rate = st.rate || 1;
  if (player.getPlaybackRate() !== rate) player.setPlaybackRate(rate);
  if (now < holdUntil || ls === 3 || st.ad) return;
  const drift = player.getCurrentTime() - t;
  if (Math.abs(drift) > (playing ? 1 : 0.4)) {
    player.seekTo(t + (playing ? 0.4 * rate : 0), true); // um pouco à frente: o tempo de carregar
    holdUntil = now + 2500;
  }
}

export function initMirror(getState) {
  get = getState;
  $("thumbWrap").addEventListener("click", () => {
    if (navigator.vibrate) navigator.vibrate(10);
    if (on) close(); else open();
  });
  $("mirrorSnd").addEventListener("click", (e) => {
    e.stopPropagation();
    muted = !muted;
    renderSnd();
    if (!ready) return;
    if (muted) player.mute(); else { player.unMute(); player.setVolume(100); }
  });
  document.addEventListener("visibilitychange", () => { if (on) { holdUntil = 0; sync(); } });
  renderSnd();
}
