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

  // Corrige les identifiants erronés déjà enregistrés dans le navigateur.
  const FIXED_IDS = { UC9Z1XWw1kmnvOOFsj6Bzy2g: 'UCeR8BYZS7IHYjk_9Mh5JgkA' }; // Scilabus
  for (const c of settings.channels) if (FIXED_IDS[c.id]) c.id = FIXED_IDS[c.id];
  // Reprend les images de profil de la liste par défaut pour les chaînes qui n'en ont pas encore.
  for (const c of settings.channels) {
    c.avatar ||= (window.DEFAULT_CHANNELS || []).find(d => d.id === c.id)?.avatar || '';
  }
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

  // Seules les images de profil hébergées par YouTube sont acceptées (voir la CSP dans index.html).
  const AVATAR_RE = /^https:\/\/yt3\.(ggpht|googleusercontent)\.com\//;

  // Appel à l'API YouTube Data v3 : renvoie { id, avatar } pour chaque chaîne trouvée.
  async function apiGet(endpoint, params) {
    const u = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', settings.apiKey);
    const res = await fetch(u);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('API YouTube : ' + (data.error?.message || res.status));
    return data;
  }

  async function fetchChannels(params) {
    const data = await apiGet('channels', { part: 'snippet', ...params });
    return (data.items || []).map(item => {
      const t = item.snippet?.thumbnails || {};
      const avatar = (t.medium || t.high || t.default)?.url || '';
      return { id: item.id, avatar: AVATAR_RE.test(avatar) ? avatar : '' };
    });
  }

  async function resolveHandle(handle) {
    if (!settings.apiKey) {
      throw new Error("Les @pseudos nécessitent une clé d'API YouTube. Sinon, collez l'ID de chaîne (UC…).");
    }
    const [found] = await fetchChannels({ forHandle: handle });
    if (!found) throw new Error(`Chaîne introuvable pour ${handle}.`);
    return found;
  }

  // Récupère les images de profil des chaînes (par paquets de 50, la limite de l'API).
  async function loadAvatars(channels) {
    const ids = [...new Set(channels.map(c => c.id).filter(id => CHANNEL_RE.test(id)))];
    const avatars = {};
    for (let i = 0; i < ids.length; i += 50) {
      for (const { id, avatar } of await fetchChannels({ id: ids.slice(i, i + 50).join(','), maxResults: 50 })) {
        if (avatar) avatars[id] = avatar;
      }
    }
    let count = 0;
    for (const c of channels) {
      if (avatars[c.id]) { c.avatar = avatars[c.id]; count += 1; }
    }
    return count;
  }

  // Image de profil si disponible, sinon l'emoji (y compris si l'image ne se charge pas).
  function channelIcon(c, className) {
    const emoji = el('span', { className: className + ' emoji', textContent: c.emoji || '📺' });
    if (!c.avatar) return emoji;
    const img = el('img', { className, src: c.avatar, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(emoji), { once: true });
    return img;
  }

  // Une chaîne UC… a une playlist « toutes les vidéos » UU… ; une playlist est utilisée telle quelle.
  const playlistOf = (id) => CHANNEL_RE.test(id) ? 'UU' + id.slice(2) : id;

  const PLAYER_PARAMS = { rel: '0', iv_load_policy: '3', playsinline: '1', modestbranding: '1', hl: 'fr', autoplay: '1' };

  // Lecteur sur toute la chaîne (ou la playlist).
  function embedUrl(id) {
    const p = new URLSearchParams({ list: playlistOf(id), ...PLAYER_PARAMS });
    return 'https://www.youtube-nocookie.com/embed/videoseries?' + p;
  }

  // Lecteur sur une vidéo précise, suivie des vidéos suivantes de la liste.
  // Le lecteur joue la liste « playlist » à partir de son premier élément (la vidéo de l'URL
  // est ignorée) : la vidéo choisie doit donc être en tête de liste.
  function videoEmbedUrl(videoId, nextIds) {
    const p = new URLSearchParams({ ...PLAYER_PARAMS });
    if (nextIds.length) p.set('playlist', [videoId, ...nextIds].slice(0, 50).join(','));
    return `https://www.youtube-nocookie.com/embed/${videoId}?` + p;
  }

  // ---------- Liste de vidéos de la chaîne (nécessite la clé d'API) ----------
  const VIDEOS_KEY = 'kidtube.videos.v2';
  const VIDEOS_TTL = { recent: 3 * 3600e3, popular: 24 * 3600e3 };
  const VIDEO_ID_RE = /^[\w-]{11}$/;
  const THUMB_RE = /^https:\/\/i\.ytimg\.com\//;

  // « PT1H2M3S » → « 1:02:03 »
  function formatDuration(iso) {
    const [, h = 0, m = 0, sec = 0] = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '') || [];
    const pad = (n) => String(n).padStart(2, '0');
    return +h ? `${h}:${pad(m)}:${pad(sec)}` : `${+m}:${pad(sec)}`;
  }

  async function fetchVideos(id, kind) {
    let ids;
    if (kind === 'popular') {
      // La recherche coûte 100 unités de quota : le résultat est gardé 24 h.
      const data = await apiGet('search', {
        part: 'id', channelId: id, order: 'viewCount', type: 'video', safeSearch: 'strict', maxResults: 30,
      });
      ids = (data.items || []).map(it => it.id?.videoId);
    } else {
      const data = await apiGet('playlistItems', { part: 'contentDetails', playlistId: playlistOf(id), maxResults: 30 });
      ids = (data.items || []).map(it => it.contentDetails?.videoId);
    }
    ids = ids.filter(v => VIDEO_ID_RE.test(v || ''));
    if (!ids.length) return [];

    // Titres, miniatures et durées ; on écarte les vidéos non intégrables et les directs.
    const data = await apiGet('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') });
    const byId = new Map((data.items || []).map(v => [v.id, v]));
    return ids.map(v => byId.get(v)).filter(v =>
      v && v.status?.embeddable !== false && (v.snippet?.liveBroadcastContent || 'none') === 'none'
    ).map(v => {
      const t = v.snippet.thumbnails || {};
      const thumb = (t.medium || t.high || t.default)?.url || '';
      const large = (t.high || t.medium || t.default)?.url || '';
      return {
        id: v.id,
        title: v.snippet.title || '',
        description: (v.snippet.description || '').slice(0, 300),
        published: v.snippet.publishedAt || '',
        thumb: THUMB_RE.test(thumb) ? thumb : '',
        thumbLarge: THUMB_RE.test(large) ? large : '',
        duration: formatDuration(v.contentDetails?.duration),
      };
    });
  }

  const pendingVideos = new Map(); // requêtes en cours, pour ne pas appeler l'API deux fois

  function getVideos(id, kind) {
    const cache = load(VIDEOS_KEY, {});
    const key = kind + ':' + id;
    if (cache[key] && Date.now() - cache[key].at < VIDEOS_TTL[kind]) return Promise.resolve(cache[key].videos);
    if (!pendingVideos.has(key)) {
      pendingVideos.set(key, fetchAndCacheVideos(id, kind, key).finally(() => pendingVideos.delete(key)));
    }
    return pendingVideos.get(key);
  }

  async function fetchAndCacheVideos(id, kind, key) {
    const videos = await fetchVideos(id, kind);
    const cache = load(VIDEOS_KEY, {});
    // On ne garde que les entrées récentes pour ne pas remplir le stockage.
    for (const k of Object.keys(cache)) if (Date.now() - cache[k].at > 24 * 3600e3) delete cache[k];
    cache[key] = { at: Date.now(), videos };
    save(VIDEOS_KEY, cache);
    return videos;
  }

  let videoKind = 'recent';
  let videoRequest = 0;

  function selectTab(kind) {
    videoKind = kind;
    for (const tab of document.querySelectorAll('#videos .tab')) {
      const on = tab.dataset.kind === kind;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    }
  }

  async function renderVideos() {
    const chan = settings.channels[current];
    const panel = $('videos');
    const list = $('videoList');
    const status = $('videoStatus');
    list.replaceChildren();
    show(panel, Boolean(settings.apiKey && chan));
    if (!settings.apiKey || !chan) return;
    show($('popularTab'), CHANNEL_RE.test(chan.id));

    const request = ++videoRequest;
    status.textContent = 'Chargement des vidéos…';
    show(status, true);
    let videos;
    try {
      videos = await getVideos(chan.id, videoKind);
    } catch {
      if (request === videoRequest) status.textContent = 'Impossible de charger la liste des vidéos.';
      return;
    }
    if (request !== videoRequest) return; // l'enfant a changé de chaîne entre-temps

    show(status, videos.length === 0);
    status.textContent = 'Aucune vidéo.';
    list.replaceChildren(...videos.map((v, i) => {
      const thumb = v.thumb
        ? el('img', { className: 'video-thumb', src: v.thumb, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
        : el('span', { className: 'video-thumb' });
      const btn = el('button', { type: 'button', className: 'video' }, [
        el('span', { className: 'video-thumb-wrap' }, [thumb, el('span', { className: 'video-duration', textContent: v.duration })]),
        el('span', { className: 'video-title', textContent: v.title }),
      ]);
      btn.dataset.id = v.id;
      btn.classList.toggle('playing', v.id === playingId);
      btn.addEventListener('click', () => playVideo(videos, i));
      return el('li', {}, btn);
    }));
  }

  let playingId = null;

  function playVideo(videos, i) {
    if (timeIsUp()) { showTimeUp(); return; }
    playingId = videos[i].id;
    iframe.src = videoEmbedUrl(videos[i].id, videos.slice(i + 1).map(v => v.id));
    for (const b of document.querySelectorAll('#videoList .video')) {
      b.classList.toggle('playing', b.dataset.id === videos[i].id);
    }
    iframe.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  for (const tab of document.querySelectorAll('#videos .tab')) {
    tab.addEventListener('click', () => { selectTab(tab.dataset.kind); renderVideos(); });
  }

  // ---------- Écrans ----------
  const iframe = $('yt');
  let current = -1;

  // « il y a 3 jours »
  const relTime = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  function timeAgo(iso) {
    const s = (Date.parse(iso) - Date.now()) / 1000;
    if (!Number.isFinite(s)) return '';
    for (const [unit, secs] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600]]) {
      if (Math.abs(s) >= secs) return relTime.format(Math.round(s / secs), unit);
    }
    return relTime.format(Math.round(s / 60), 'minute');
  }

  let gridRequest = 0;

  // Accueil : une carte par chaîne. Avec la clé d'API, la carte montre la dernière vidéo
  // (vignette, titre, description) ; sinon, la photo ou l'emoji de la chaîne.
  function renderGrid() {
    const grid = $('grid');
    const request = ++gridRequest;
    grid.replaceChildren(...settings.channels.map((c, i) => {
      const cover = el('span', { className: 'card-cover' }, channelIcon(c, 'cover-icon'));
      cover.style.setProperty('--hue', hueOf(c.name));
      const title = el('span', { className: 'card-title', textContent: c.name });
      const desc = el('span', { className: 'card-desc' });
      const card = el('button', { className: 'vcard', type: 'button' }, [
        cover,
        el('span', { className: 'card-body' }, [
          settings.apiKey ? channelIcon(c, 'card-avatar') : '',
          el('span', { className: 'card-text' }, [
            title,
            el('span', { className: 'card-channel' }),
            desc,
          ]),
        ]),
      ]);
      let latest = null;
      card.addEventListener('click', () => {
        watch(i);
        if (latest) playVideo(latest, 0);
      });

      if (settings.apiKey) {
        card.classList.add('loading');
        getVideos(c.id, 'recent').then(videos => {
          if (request !== gridRequest || !videos.length) return;
          latest = videos;
          const v = videos[0];
          if (v.thumbLarge || v.thumb) {
            cover.replaceChildren(
              el('img', { className: 'cover-img', src: v.thumbLarge || v.thumb, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }),
              el('span', { className: 'video-duration', textContent: v.duration }),
            );
          }
          title.textContent = v.title;
          card.querySelector('.card-channel').textContent = [c.name, timeAgo(v.published)].filter(Boolean).join(' · ');
          desc.textContent = v.description.replace(/\s+/g, ' ').trim();
        }).catch(() => {}).finally(() => card.classList.remove('loading'));
      }
      return card;
    }));
    show($('empty'), settings.channels.length === 0);
  }

  function watch(index, { push = true } = {}) {
    const n = settings.channels.length;
    if (!n) return;
    if (timeIsUp()) { showTimeUp(); return; }
    current = ((index % n) + n) % n;
    playingId = null;
    const chan = settings.channels[current];
    iframe.src = embedUrl(chan.id);
    $('title').textContent = `${chan.emoji || '📺'} ${chan.name}`;
    document.title = `${chan.name} — KidTube`;
    show($('home'), false);
    show($('watch'), true);
    show($('homeBtn'), true);
    if (push) history.pushState({ watch: current }, '');
    else history.replaceState({ watch: current }, '');
    selectTab('recent');
    renderVideos();
  }

  function goHome({ fromHistory = false } = {}) {
    iframe.src = 'about:blank';
    current = -1;
    videoRequest += 1;
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
        channelIcon(c, 'chan-icon'),
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
      const found = source.id ? { id: source.id, avatar: '' } : await resolveHandle(source.handle);
      if (settings.channels.some(c => c.id === found.id)) throw new Error('Cette chaîne est déjà dans la liste.');
      const chan = {
        name: $('addName').value.trim(),
        emoji: $('addEmoji').value.trim() || '📺',
        id: found.id,
        avatar: found.avatar,
      };
      if (!chan.avatar && settings.apiKey) await loadAvatars([chan]).catch(() => 0);
      settings.channels.push(chan);
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
    if (settings.apiKey) refreshAvatars();
  });

  async function refreshAvatars() {
    const status = $('avatarStatus');
    show(status, true);
    if (!settings.apiKey) {
      status.textContent = "Renseignez d'abord une clé d'API YouTube ci-dessus.";
      return;
    }
    status.textContent = 'Chargement des photos…';
    try {
      const n = await loadAvatars(settings.channels);
      channelsChanged();
      status.textContent = `${n} photo${n > 1 ? 's' : ''} de chaîne chargée${n > 1 ? 's' : ''}.`;
    } catch (ex) {
      status.textContent = ex.message;
    }
  }
  $('avatarsBtn').addEventListener('click', refreshAvatars);

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
      settings.channels = chans.map(({ name, emoji, id, avatar }) => ({
        name, emoji: emoji || '📺', id, avatar: AVATAR_RE.test(avatar || '') ? avatar : '',
      }));
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
