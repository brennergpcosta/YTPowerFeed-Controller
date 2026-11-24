# YTPowerFeed Controle

Controle remoto, no celular, do YouTube aberto no PC com a extensão YTPowerFeed.

- Página estática (GitHub Pages), instalável como app ("Adicionar à tela inicial").
- Pareamento pelo QR code do pop-up da extensão (aba Player > Controle remoto no celular). A chave vem depois do `#` do link, fica só neste aparelho e nunca vai a servidor nenhum.
- Conexão direta celular ↔ PC por WebRTC. Para se acharem, a oferta e a resposta passam pelo [ntfy.sh](https://ntfy.sh), criptografadas (AES-GCM com a chave do QR); o tópico é derivado da chave.
- O lado do PC fica no `content/remote.js` da extensão (repositório privado YTPowerFeed).

- Tocar na capa do "Tocando agora" passa no celular o vídeo que toca no PC, mandado pelo próprio PC pela conexão direta na rede de casa (sem internet, até 480p), mudo por padrão com botão de som. Só no Wi-Fi; com a tela apagada o PC para de mandar.

Arquivos: `index.html`, `style.css`, `app.js` (tudo), `mirror.js` (vídeo na capa), `sw.js` (cache para abrir rápido), `manifest.webmanifest` e `icons/`.
