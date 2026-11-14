// CEL Conecta — service worker (na pasta conecta/ do Portal CEL)
// Guarda só a "casca" do app (página e ícones) para abrir depressa.
// As mensagens, publicações e anexos vêm SEMPRE do servidor e nunca ficam em cache.
const VERSAO = 'cel-conecta-v26';
const EXTERNOS = 'cel-externos';   // biblioteca do Supabase e tipos de letra (para abrir sem internet)
const HOSTS_EXTERNOS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];
const CASCA = ['./', './index.html', './manifest.json', './cel-icone-192.png', './cel-icone-512.png', './cel-icone-180.png', './cel-notificacao.png', './toque-hino.mp3'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(CASCA.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // só as cópias antigas do próprio CEL Conecta: no mesmo endereço estão também as do Portal (manuais dos professores, gestão)
      .then((nomes) => Promise.all(nomes.filter((n) => n.startsWith('cel-conecta-v') && n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const pedido = e.request;
  const url = new URL(pedido.url);
  // ficheiros/textos partilhados a partir de outras apps (WhatsApp, Galeria…)
  if (pedido.method === 'POST' && url.pathname.endsWith('/partilhar-recebido')) {
    e.respondWith((async () => {
      try {
        const dados = await pedido.formData();
        const c = await caches.open('cel-partilha');
        for (const k of await c.keys()) await c.delete(k);
        const ficheiros = dados.getAll('ficheiros').filter((f) => f && f.size);
        const lista = [];
        for (let i = 0; i < ficheiros.length && i < 10; i++) {
          const f = ficheiros[i], chave = './partilha/' + i;
          await c.put(chave, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
          lista.push({ chave, nome: f.name || ('ficheiro-' + (i + 1)), tipo: f.type || '' });
        }
        const texto = [dados.get('titulo'), dados.get('texto'), dados.get('link')].filter(Boolean).join('\n').trim();
        await c.put('./partilha/info', new Response(JSON.stringify({ ficheiros: lista, texto, quando: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
      } catch (err) { /* segue para o app na mesma */ }
      return Response.redirect('./?partilha=1', 303);
    })());
    return;
  }
  if (pedido.method !== 'GET') return;
  if (HOSTS_EXTERNOS.includes(url.hostname)) {
    // usa a cópia guardada logo (rápido e funciona sem rede) e atualiza-a em segundo plano
    e.respondWith(caches.open(EXTERNOS).then(async (c) => {
      const guardada = await c.match(pedido);
      const daRede = fetch(pedido).then((resp) => { if (resp.ok || resp.type === 'opaque') c.put(pedido, resp.clone()); return resp; }).catch(() => guardada);
      return guardada || daRede;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return; // servidor Supabase: direto, sem cache
  // Abre logo com a cópia guardada (rápido, mesmo com internet fraca) e atualiza-a em segundo plano.
  // Quando sai uma versão nova, este ficheiro muda e o app recarrega sozinho com ela.
  e.respondWith((async () => {
    const c = await caches.open(VERSAO);
    const chave = pedido.mode === 'navigate' ? './index.html' : pedido;
    const guardada = await c.match(chave, { ignoreSearch: pedido.mode === 'navigate' });
    const daRede = fetch(pedido).then((resp) => {
      if (resp.ok && resp.type === 'basic') c.put(chave, resp.clone());
      return resp;
    }).catch(() => null);
    if (guardada) { e.waitUntil(daRede); return guardada; }
    return (await daRede) || (await c.match('./index.html')) || Response.error();
  })());
});

// Ao tocar numa notificação: abre (ou traz para a frente) o app e mostra a conversa
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const conversa = e.notification.data && e.notification.data.conversa;
  const chamada = e.notification.data && e.notification.data.chamada;
  if (chamada) {
    e.waitUntil((async () => {
      const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (janelas[0]) { await janelas[0].focus(); janelas[0].postMessage({ abrirChamada: chamada }); }
      else await self.clients.openWindow('./?chamada=' + chamada);
    })());
    return;
  }
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let janela = janelas[0];
    if (janela) { await janela.focus(); }
    else { janela = await self.clients.openWindow('./'); }
    if (janela && conversa && conversa !== 'teste') {
      if (!janelas.length) await new Promise((r) => setTimeout(r, 2000));   // dar tempo ao app para abrir
      janela.postMessage({ abrirConversa: conversa });
    }
  })());
});

// Notificação que chega do servidor (mesmo com o app fechado)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { titulo: 'CEL Conecta', corpo: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    // não avisar sobre a conversa que a pessoa está a ver neste momento
    // (no iPhone mostra-se sempre: o sistema exige um aviso por cada notificação recebida)
    const iphone = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visivel = janelas.some((j) => j.visibilityState === 'visible');
    // chamadas: toca como uma chamada (com o app aberto, é o próprio app que toca)
    if (d.tipo === 'chamada') {
      if (visivel && !iphone) return;
      await self.registration.showNotification(d.titulo || 'Chamada', {
        body: d.corpo || 'Toque para atender', icon: 'cel-icone-192.png', badge: 'cel-notificacao.png', tag: 'chamada-' + d.chamada,
        renotify: true, requireInteraction: true, vibrate: [500, 250, 500, 250, 500, 250, 500], data: { chamada: d.chamada, conversa: d.conversa }
      });
      return;
    }
    if (d.tipo === 'chamada-fim') {   // quem ligou desistiu: troca o "a tocar" por "chamada perdida"
      (await self.registration.getNotifications({ tag: 'chamada-' + d.chamada })).forEach((n) => n.close());
      await self.registration.showNotification(d.titulo || 'Chamada perdida', { body: d.corpo || '', icon: 'cel-icone-192.png', badge: 'cel-notificacao.png', tag: 'perdida-' + d.chamada, data: { conversa: d.conversa } });
      return;
    }
    if (!iphone && aVer && aVer === d.conversa && janelas.some((j) => j.visibilityState === 'visible')) return;
    await self.registration.showNotification(d.titulo || 'CEL Conecta', {
      body: d.corpo || '', icon: 'cel-icone-192.png', badge: 'cel-notificacao.png',
      tag: 'cel-' + (d.conversa || 'geral'), renotify: true, data: { conversa: d.conversa || '' }
    });
  })());
});

// o app diz qual conversa está aberta no ecrã
let aVer = '';
self.addEventListener('message', (e) => { if (e.data && 'aVer' in e.data) aVer = e.data.aVer || ''; });
