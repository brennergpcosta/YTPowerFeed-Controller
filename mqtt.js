/**
 * Carteiro reserva do controle remoto: um servidor MQTT público e gratuito (por WebSocket), usado
 * junto com o ntfy.sh para o pedido de conexão e o "toque" da vaga de reconexão. Vale o que chegar
 * primeiro. Só passam mensagens já criptografadas (as mesmas do ntfy). Cliente MQTT 3.1.1 mínimo:
 * conectar, assinar um tópico, publicar e receber (QoS 0), com ping a cada 30 s.
 * A mesma conta está no content/remote.js da extensão: mudou aqui, muda lá.
 */

export const MQTT_URLS = ["wss://broker.hivemq.com:8884/mqtt", "wss://broker.emqx.io:8084/mqtt"];

const enc = new TextEncoder();
const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
function packet(type, body) {
  const out = [type];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0);
  return new Uint8Array([...out, ...body]);
}

export class Mqtt {
  constructor(topic, onMessage) {
    this.topic = topic;
    this.onMessage = onMessage;
    this.ws = null;
    this.ready = false;
    this.urlIdx = 0;
    this.retry = 0;
    this.lastRx = 0;
    this.stopped = false;
    this.buf = new Uint8Array(0);
  }

  start() {
    this.stopped = false;
    if (this.ws && this.ws.readyState <= 1) return;
    clearTimeout(this.retryTimer);
    let ws;
    try { ws = new WebSocket(MQTT_URLS[this.urlIdx % MQTT_URLS.length], "mqtt"); } catch (err) { this.later(); return; }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.ready = false;
    this.buf = new Uint8Array(0);
    ws.onopen = () => {
      const id = `ytpf-${Math.random().toString(36).slice(2, 12)}`;
      ws.send(packet(0x10, [...str("MQTT"), 4, 0x02, 0, 60, ...str(id)]));
    };
    ws.onmessage = (e) => { this.lastRx = Date.now(); this.feed(new Uint8Array(e.data)); };
    ws.onclose = () => { if (this.ws !== ws) return; this.ready = false; this.ws = null; this.later(); };
    ws.onerror = () => {};
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { if (this.ready) try { ws.send(new Uint8Array([0xc0, 0])); } catch (err) {} }, 30000);
  }

  later() {
    if (this.stopped) return;
    this.urlIdx++;
    this.retry = Math.min(this.retry + 1, 6);
    this.retryTimer = setTimeout(() => this.start(), [1, 2, 5, 10, 20, 40][this.retry - 1] * 1000);
  }

  // Depois de o celular dormir, o WebSocket pode ter morrido calado: abre de novo
  refresh() {
    if (this.stopped) return;
    if (!this.ws || !this.ready || Date.now() - this.lastRx > 45000) {
      try { this.ws?.close(); } catch (err) {}
      this.ws = null;
      this.retry = 0;
      this.start();
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch (err) {}
    this.ws = null;
    this.ready = false;
  }

  publish(text) {
    if (!this.ready) return false;
    try { this.ws.send(packet(0x30, [...str(this.topic), ...enc.encode(text)])); return true; } catch (err) { return false; }
  }

  feed(chunk) {
    const all = new Uint8Array(this.buf.length + chunk.length);
    all.set(this.buf);
    all.set(chunk, this.buf.length);
    let pos = 0;
    while (pos < all.length) {
      let mult = 1, len = 0, i = pos + 1, byte;
      do {
        if (i >= all.length) { this.buf = all.slice(pos); return; }
        byte = all[i++];
        len += (byte & 127) * mult;
        mult *= 128;
      } while (byte & 128);
      if (i + len > all.length) { this.buf = all.slice(pos); return; }
      this.handle(all[pos], all.subarray(i, i + len));
      pos = i + len;
    }
    this.buf = new Uint8Array(0);
  }

  handle(type, body) {
    const kind = type >> 4;
    if (kind === 2) { // CONNACK
      if (body[1] !== 0) { try { this.ws.close(); } catch (err) {} return; }
      this.ready = true;
      this.retry = 0;
      this.ws.send(packet(0x82, [0, 1, ...str(this.topic), 0]));
    } else if (kind === 3) { // PUBLISH
      const qos = (type >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      let p = 2 + tlen;
      if (qos > 0) p += 2;
      try { this.onMessage(new TextDecoder().decode(body.subarray(p))); } catch (err) {}
    }
  }
}
