(() => {
  'use strict';

  // ---------- Stockage ----------
  const STORE_KEY = 'kidtube.settings.v1';
  const USAGE_KEY = 'kidtube.usage.v1';

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  }

  const defaults = () => ({
    channels: (window.DEFAULT_CHANNELS || []).map(c => ({ ...c })),
    pinHash: null,
    limitMin: 0,
    apiKey: '',
  });

  const settings = Object.assign(defaults(), load(STORE_KEY, {}));
  const persist = () => save(STORE_KEY, settings);

  const today = () => new Date().toLocaleDateString('sv'); // AAAA-MM-JJ, heure locale
  let usage = load(USAGE_KEY, null);
  function currentUsage() {
    if (!usage || usage.date !== today()) usage = { date: today(), seconds: 0, bonusMin: 0 };
    return usage;
  }

  // ---------- Utilitaires ----------
  const $ = (id) => document.getElementById(id);
  const show = (el, visible = true) => { el.hidden = !visible; };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) node.append(child);
    return node;
  }

  function hueOf(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  async function sha256(text) {
    if (window.crypto?.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
    }
    // Contexte non sécurisé (http:// hors localhost) : repli sur un hachage simple.
    let h = 0x811c9dc5;
    for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
    return 'fnv-' + h.toString(16);
  }
  const hashPin = (pin) => sha256('kidtube:' + pin);

  // ---------- Chaînes et playlists ----------
  const CHANNEL_RE = /^UC[\w-]{22}$/;
  const PLAYLIST_RE = /^(PL|UU|OL|FL|LL)[\w-]{10,}$/;
  const HANDLE_RE = /^@[\w.\-·]{3,30}$/;

  // Transforme ce que le parent a collé en { id } ou { handle }.
  function parseSource(input) {
    const text = input.trim();
    if (CHANNEL_RE.test(text) || PLAYLIST_RE.test(text)) return { id: text };
    if (HANDLE_RE.test(text)) return { handle: text };

    let url;
    try { url = new URL(text.includes('://') ? text : 'https://' + text); } catch { return null; }
    if (!/(^|\.)youtube(-nocookie)?\.com$/.test(url.hostname)) return null;

    const list = url.searchParams.get('list');
    if (list && PLAYLIST_RE.test(list)) return { id: list };

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'channel' && CHANNEL_RE.test(parts[1] || '')) return { id: parts[1] };
    if (parts[0] && HANDLE_RE.test(decodeURIComponent(parts[0]))) return { handle: decodeURIComponent(parts[0]) };
    return null;
  }

  async function resolveHandle(handle) {
    if (!settings.apiKey) {
      throw new Error("Les @pseudos nécessitent une clé d'API YouTube. Sinon, collez l'ID de chaîne (UC…).");
    }
    const u = new URL('https://www.googleapis.com/youtube/v3/channels');
    u.searchParams.set('part', 'id');
    u.searchParams.set('forHandle', handle);
    u.searchParams.set('key', settings.apiKey);
    const res = await fetch(u);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('API YouTube : ' + (data.error?.message || res.status));
    const id = data.items?.[0]?.id;
    if (!id) throw new Error(`Chaîne introuvable pour ${handle}.`);
    return id;
  }

  // Une chaîne UC… a une playlist « toutes les vidéos » UU… ; une playlist est utilisée telle quelle.
  const playlistOf = (id) => CHANNEL_RE.test(id) ? 'UU' + id.slice(2) : id;

  function embedUrl(id) {
    const p = new URLSearchParams({
      list: playlistOf(id),
      rel: '0',
      iv_load_policy: '3',
      playsinline: '1',
      modestbranding: '1',
      hl: 'fr',
      autoplay: '1',
    });
    return 'https://www.youtube-nocookie.com/embed/videoseries?' + p;
  }

  // ---------- Écrans ----------
  const iframe = $('yt');
  let current = -1;

  function renderGrid() {
    const grid = $('grid');
    grid.replaceChildren(...settings.channels.map((c, i) => {
      const tile = el('button', { className: 'tile', type: 'button' }, [
        el('span', { className: 'tile-emoji', textContent: c.emoji || '📺' }),
        el('span', { className: 'tile-name', textContent: c.name }),
      ]);
      tile.style.setProperty('--hue', hueOf(c.name));
      tile.addEventListener('click', () => watch(i));
      return tile;
    }));
    show($('empty'), settings.channels.length === 0);
  }

  function watch(index, { push = true } = {}) {
    const n = settings.channels.length;
    if (!n) return;
    if (timeIsUp()) { showTimeUp(); return; }
    current = ((index % n) + n) % n;
    const chan = settings.channels[current];
    iframe.src = embedUrl(chan.id);
    $('title').textContent = `${chan.emoji || '📺'} ${chan.name}`;
    document.title = `${chan.name} — KidTube`;
    show($('home'), false);
    show($('watch'), true);
    show($('homeBtn'), true);
    if (push) history.pushState({ watch: current }, '');
    else history.replaceState({ watch: current }, '');
  }

  function goHome({ fromHistory = false } = {}) {
    iframe.src = 'about:blank';
    current = -1;
    $('title').textContent = 'KidTube';
    document.title = 'KidTube';
    show($('watch'), false);
    show($('home'), true);
    show($('homeBtn'), false);
    if (!fromHistory && history.state?.watch !== undefined) history.back();
  }

  $('homeBtn').addEventListener('click', () => goHome());
  $('prevBtn').addEventListener('click', () => watch(current - 1, { push: false }));
  $('nextBtn').addEventListener('click', () => watch(current + 1, { push: false }));
  // Bouton « retour » du téléphone / navigateur : revient à l'accueil au lieu de quitter.
  window.addEventListener('popstate', () => { if (current !== -1) goHome({ fromHistory: true }); });

  // ---------- Temps d'écran ----------
  const isOverlayOpen = () => !$('parent').hidden || !$('pinDialog').hidden || !$('timeUp').hidden;
  const allowedSeconds = () => (settings.limitMin + currentUsage().bonusMin) * 60;
  const timeIsUp = () => settings.limitMin > 0 && currentUsage().seconds >= allowedSeconds();

  function showTimeUp() {
    goHome();
    show($('timeUp'), true);
  }

  function renderTimer() {
    const t = $('timer');
    if (!settings.limitMin) { show(t, false); return; }
    const left = Math.max(0, allowedSeconds() - currentUsage().seconds);
    t.textContent = `⏳ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    t.classList.toggle('low', left < 120);
    show(t, true);
  }

  setInterval(() => {
    const watching = current !== -1 && document.visibilityState === 'visible' && !isOverlayOpen();
    if (watching) {
      currentUsage().seconds += 1;
      save(USAGE_KEY, usage);
      if (timeIsUp()) showTimeUp();
    }
    renderTimer();
  }, 1000);

  // ---------- Code PIN ----------
  let pinResolve = null;
  let pinMode = 'check'; // 'check' | 'create'
  let failures = 0;
  let lockedUntil = 0;

  function askPin(mode = settings.pinHash ? 'check' : 'create') {
    pinMode = mode;
    const creating = mode === 'create';
    $('pinTitle').textContent = creating ? 'Créer un code PIN parent' : 'Espace parents';
    $('pinHelp').textContent = creating
      ? 'Choisissez un code de 4 à 12 chiffres. Il protège les réglages.'
      : 'Entrez votre code PIN.';
    $('pinInput').value = '';
    $('pinInput2').value = '';
    show($('pinInput2'), creating);
    $('pinInput2').required = creating;
    show($('pinError'), false);
    show($('pinDialog'), true);
    $('pinInput').focus();
    return new Promise(resolve => { pinResolve = resolve; });
  }

  function closePin(ok) {
    show($('pinDialog'), false);
    const resolve = pinResolve;
    pinResolve = null;
    resolve?.(ok);
  }

  function pinError(msg) {
    $('pinError').textContent = msg;
    show($('pinError'), true);
    $('pinInput').value = '';
    $('pinInput').focus();
  }

  $('pinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = $('pinInput').value.trim();
    if (!/^\d{4,12}$/.test(pin)) return pinError('Le code doit contenir 4 à 12 chiffres.');

    if (pinMode === 'create') {
      if (pin !== $('pinInput2').value.trim()) return pinError('Les deux codes ne correspondent pas.');
      settings.pinHash = await hashPin(pin);
      persist();
      return closePin(true);
    }

    const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
    if (wait > 0) return pinError(`Trop d'essais. Réessayez dans ${wait} s.`);
    if (await hashPin(pin) === settings.pinHash) {
      failures = 0;
      return closePin(true);
    }
    failures += 1;
    if (failures >= 5) { lockedUntil = Date.now() + 30_000; failures = 0; }
    pinError('Code incorrect.');
  });
  $('pinCancel').addEventListener('click', () => closePin(false));

  // ---------- Espace parents ----------
  async function openParent() {
    if (!await askPin()) return;
    goHome();
    show($('timeUp'), false);
    renderParent();
    show($('parent'), true);
  }

  function closeParent() {
    show($('parent'), false);
    if (timeIsUp()) show($('timeUp'), true);
  }

  $('parentBtn').addEventListener('click', openParent);
  $('timeUpParent').addEventListener('click', openParent);
  $('parentClose').addEventListener('click', closeParent);

  function renderParent() {
    renderChanList();
    $('limitInput').value = settings.limitMin;
    $('apiKeyInput').value = settings.apiKey;
    renderUsage();
  }

  function renderUsage() {
    const u = currentUsage();
    const min = Math.floor(u.seconds / 60);
    const bonus = u.bonusMin ? ` (dont +${u.bonusMin} min accordées)` : '';
    $('usedToday').textContent = settings.limitMin
      ? `Aujourd'hui : ${min} min regardées sur ${settings.limitMin + u.bonusMin} min${bonus}.`
      : `Aujourd'hui : ${min} min regardées.`;
  }

  function channelsChanged() {
    persist();
    renderChanList();
    renderGrid();
  }

  function renderChanList() {
    const list = $('chanList');
    const chans = settings.channels;
    list.replaceChildren(...chans.map((c, i) => {
      const btn = (label, title, onClick, disabled = false) => {
        const b = el('button', { type: 'button', className: 'mini', textContent: label, title, disabled });
        b.setAttribute('aria-label', title);
        b.addEventListener('click', onClick);
        return b;
      };
      const move = (d) => () => { [chans[i], chans[i + d]] = [chans[i + d], chans[i]]; channelsChanged(); };
      return el('li', {}, [
        el('span', { className: 'chan-emoji', textContent: c.emoji || '📺' }),
        el('span', { className: 'chan-name', textContent: c.name }),
        el('code', { className: 'chan-id', textContent: c.id }),
        btn('▲', 'Monter', move(-1), i === 0),
        btn('▼', 'Descendre', move(1), i === chans.length - 1),
        btn('✕', 'Retirer ' + c.name, () => {
          if (confirm(`Retirer « ${c.name} » ?`)) { chans.splice(i, 1); channelsChanged(); }
        }),
      ]);
    }));
  }

  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('addError');
    show(err, false);
    const source = parseSource($('addId').value);
    try {
      if (!source) throw new Error("Format non reconnu. Collez un ID UC…, un lien de chaîne YouTube ou un lien de playlist.");
      const id = source.id || await resolveHandle(source.handle);
      if (settings.channels.some(c => c.id === id)) throw new Error('Cette chaîne est déjà dans la liste.');
      settings.channels.push({
        name: $('addName').value.trim(),
        emoji: $('addEmoji').value.trim() || '📺',
        id,
      });
      channelsChanged();
      e.target.reset();
    } catch (ex) {
      err.textContent = ex.message;
      show(err, true);
    }
  });

  $('limitInput').addEventListener('change', (e) => {
    settings.limitMin = Math.max(0, Math.min(600, parseInt(e.target.value, 10) || 0));
    e.target.value = settings.limitMin;
    persist();
    renderUsage();
  });
  $('add15').addEventListener('click', () => {
    currentUsage().bonusMin += 15;
    save(USAGE_KEY, usage);
    renderUsage();
  });
  $('resetToday').addEventListener('click', () => {
    Object.assign(currentUsage(), { seconds: 0, bonusMin: 0 });
    save(USAGE_KEY, usage);
    renderUsage();
  });

  $('apiKeyInput').addEventListener('change', (e) => {
    settings.apiKey = e.target.value.trim();
    persist();
  });

  $('changePin').addEventListener('click', async () => {
    show($('parent'), false);
    await askPin('create');
    show($('parent'), true);
  });

  $('resetChannels').addEventListener('click', () => {
    if (!confirm('Remplacer votre liste par les chaînes par défaut ?')) return;
    settings.channels = defaults().channels;
    channelsChanged();
  });

  $('exportBtn').addEventListener('click', () => {
    const data = JSON.stringify({ channels: settings.channels, limitMin: settings.limitMin }, null, 2);
    const a = el('a', {
      href: URL.createObjectURL(new Blob([data], { type: 'application/json' })),
      download: 'kidtube-reglages.json',
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const chans = (data.channels || []).filter(c =>
        c && typeof c.name === 'string' && (CHANNEL_RE.test(c.id) || PLAYLIST_RE.test(c.id)));
      if (!chans.length) throw new Error();
      settings.channels = chans.map(({ name, emoji, id }) => ({ name, emoji: emoji || '📺', id }));
      if (Number.isFinite(data.limitMin)) settings.limitMin = Math.max(0, Math.min(600, data.limitMin));
      channelsChanged();
      renderParent();
    } catch {
      alert("Fichier invalide : aucune chaîne n'a pu être importée.");
    }
  });

  // ---------- Démarrage ----------
  renderGrid();
  renderTimer();
  if (timeIsUp()) show($('timeUp'), true);
  if (history.state?.watch !== undefined) history.replaceState(null, '');
})();
