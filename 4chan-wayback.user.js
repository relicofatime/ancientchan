// ==UserScript==
// @name         ancientchan
// @namespace    4chan-wayback-machine
// @version      0.9.1
// @description  4chan time machine. Replays archived 4chan boards in real time with era-correct UI. Visit a real 4chan board URL and travel back to a set date; posts stream in at the exact second they were originally posted. Data from FoolFuuka archives (desuarchive / 4plebs / archived.moe).
// @author       relicofatime
// @match        *://boards.4chan.org/*
// @match        *://boards.4channel.org/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @connect      desuarchive.org
// @connect      archive.4plebs.org
// @connect      archived.moe
// @connect      desu-usergeneratedcontent.xyz
// @connect      archive.org
// @connect      *.archive.org
// @connect      us.archive.org
// @connect      arch.b4k.dev
// @connect      arch.b4k.co
// @connect      arch-img.b4k.dev
// @connect      arch-img.b4k.co
// @connect      archive-media.palanq.win
// @connect      archive.palanq.win
// @connect      archive.alice.al
// @connect      eientei.xyz
// @connect      archiveofsins.com
// @connect      thebarchive.com
// @connect      img.4plebs.org
// @connect      i.4cdn.org
// @connect      images.4chan.org
// @connect      s.4cdn.org
// @connect      derpicdn.net
// @connect      *
// ==/UserScript==

/*  ──────────────────────────────────────────────────────────────────────────
    HOW IT WORKS  (v0.1 vertical slice)
    ----------------------------------------------------------------------------
    1. You navigate to a real board, e.g.  https://boards.4chan.org/g/
    2. This script blanks the live page and overlays an era-correct (2013) UI.
    3. It enumerates that board's threads for CONFIG.date via the archive SEARCH
       endpoint (one call per page, cached forever in GM storage).
    4. A replay clock starts at the first activity of that day and advances in
       real time (× CONFIG.speed). Threads appear on the index, and replies
       stream into open threads, at the exact moment they were posted.
    5. Images are fetched as blobs (GM_xmlhttpRequest) so 4chan's CSP can't
       block the archive CDN, then shown via blob: URLs.

    DESIGN NOTES
    - We only ever SEARCH a board-day once (cached). Thread JSON is fetched once
      per thread (cached). Opening a thread = 1 request that returns ALL replies.
    - A gentle background prefetcher grabs threads for OPs as they appear on the
      index, throttled, so clicking a thread is instant. Because replay runs in
      real time, the natural request rate is a trickle — we never flood anyone.
    - Caching is in GM storage (text/JSON only — tiny). Images are never stored;
      they lazy-load from the archive CDN on demand.

    TUNE ME ↓
    ────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // We replace 4chan's page wholesale, so its own bundles (options/core/…) end up
  // running against a DOM they no longer recognise and throw — e.g. 4chan's
  // settings menu firing "e.target.closest is not a function". None of that code
  // is ours or needed by the replay, so swallow those uncaught errors to keep the
  // console clean. Our own script has a different filename and passes through.
  window.addEventListener('error', (e) => {
    const f = (e && e.filename) || '';
    if (/4cdn|options\/index|\/core\.|extension\.js/i.test(f)) e.preventDefault();
  }, true);

  // Hide 4chan's page immediately — before any DOM is parsed — so the 404
  // or live board never flashes. The full stylesheet follows in ensureStyles().
  // No class gate here: at document-start, <html> may not exist yet, so a
  // class-dependent rule would miss the window entirely.
  const _earlyHideCSS = 'html, body { visibility:hidden !important; background:#EEF2FF !important; } #wb-overlay { visibility:visible !important; }';
  try {
    GM_addStyle(_earlyHideCSS);
  } catch (e) {
    const s = document.createElement('style');
    s.textContent = _earlyHideCSS;
    (document.head || document.documentElement || document).append(s);
  }

  let _stylesInjected = false;
  const VALID_COLORS = ['yotsublue', 'yotsuba', 'tomorrow'];
  const VALID_DESIGNS = ['2012', '2005'];
  let activeColors = 'yotsublue';
  let activeDesign = '2012';
  const normColors = (c) => VALID_COLORS.includes(c) ? c : 'yotsublue';
  const normDesign = (d) => VALID_DESIGNS.includes(d) ? d : '2012';
  function applyTheme(c) {
    activeColors = normColors(c);
    const root = document.documentElement;
    if (!root) return;
    for (const v of VALID_COLORS) root.classList.toggle('wb-colors-' + v, activeColors === v);
  }
  function applyDesign(d) {
    activeDesign = normDesign(d);
    const root = document.documentElement;
    if (!root) return;
    for (const v of VALID_DESIGNS) root.classList.toggle('wb-design-' + v, activeDesign === v);
  }
  function ensureStyles() {
    if (_stylesInjected) return;
    const css = getCSS();
    try {
      GM_addStyle(css);
      _stylesInjected = true;
    } catch (e) { /* GM_addStyle unavailable */ }
    if (!_stylesInjected) {
      try {
        const s = document.createElement('style');
        s.textContent = css;
        (document.head || document.documentElement).append(s);
        _stylesInjected = true;
      } catch (e2) { /* fallback also failed */ }
    }
    if (document.documentElement) {
      document.documentElement.classList.add('wb-active');
      let saved = null;
      try { saved = JSON.parse(GM_getValue('settings', 'null')); } catch (e) { /* none yet */ }
      applyTheme(saved && saved.theme || saved && saved.colors);
      applyDesign(saved && saved.design);
    }
  }
  ensureStyles();

  const CONFIG = {
    date: '2013-06-15',   // the day to replay (YYYY-MM-DD)
    startTime: new Date().toTimeString().slice(0, 5),   // default to current local time
    speed: 1,             // time multiplier (1 = true real time)
    prefetch: true,       // background-cache threads as their OPs appear
    prefetchDelayMs: 500,
    prefetchConcurrency: 1,
    catalogActivityMaxDays: 14,
    catalogActivityThreadTarget: 150,
    catalogActivitySearchMaxPages: 6,
    catalogHydrateConcurrency: 1,
    catalogHydrateLimit: 150,
    catalogHydrateYieldMs: 200,
    catalogSyncUpdateEvery: 10,
    catalogTinyOpsThreshold: 12,
    catalogPageDelayMs: 150,
    catalogSearchMaxPages: 20,
    bumpLimit: 300,
    indexPages: 10,
    indexThreadsPerPage: 18,
    mediaResolveConcurrency: 3,
    mediaMissCacheMs: 24 * 60 * 60 * 1000,
    mediaPersistentCache: true,
    mediaPersistentMaxBytes: 8 * 1024 * 1024,
    threadPersistentCache: true,
    localPostMaxImageBytes: 1024 * 1024,
    mediaDebug: false,
    cacheDebug: false
  };

  // ── Archive routing ──────────────────────────────────────────────────────
  // Maps each board to only the FoolFuuka-compatible archives that can serve it.
  // Media fallback candidates are derived from the same coverage table.
  const DESU = 'https://desuarchive.org';
  const PLEBS = 'https://archive.4plebs.org';
  const MOE = 'https://archived.moe';
  const B4K = 'https://arch.b4k.dev';
  const PALANQ = 'https://archive.palanq.win';
  const ALICE = 'https://archive.alice.al';
  const EIENTEI = 'https://eientei.xyz';
  const SINS = 'https://archiveofsins.com';
  const THEB = 'https://thebarchive.com';

  // Authoritative FoolFuuka-compatible board coverage, ordered by query preference. A
  // board is ONLY looked up on archives whose list includes it — no archive (not
  // even archived.moe) is queried for a board it doesn't actually host.
  const ARCHIVE_COVERAGE = [
    { base: DESU,    boards: ['a', 'aco', 'an', 'c', 'cgl', 'co', 'd', 'fit', 'g', 'his', 'int', 'k', 'm', 'mlp', 'mu', 'q', 'qa', 'r9k', 'tg', 'vr', 'wsg'] },
    { base: PLEBS,   boards: ['adv', 'f', 'hr', 'o', 'pol', 's4s', 'sp', 'trv', 'tv', 'x', 'mlpol'] },
    { base: B4K,     boards: ['g', 'mlp', 'v', 'vg', 'vm', 'vmg', 'vp', 'vrpg', 'vst'] },
    { base: PALANQ,  boards: ['bant', 'c', 'con', 'e', 'i', 'n', 'news', 'out', 'p', 'pw', 'qst', 'toy', 'vip', 'vp', 'vt', 'w', 'wg', 'wsr'] },
    { base: ALICE,   boards: ['c', 'vg'] },
    { base: EIENTEI, boards: ['3', 'i', 'sci', 'xs'] },
    { base: SINS,    boards: ['h', 'hc', 'hm', 'i', 'lgbt', 'r', 's', 'soc', 't', 'u'] },
    { base: THEB,    boards: ['b', 'bant'] },
    { base: MOE,     boards: ['3', 'a', 'aco', 'adv', 'an', 'b', 'bant', 'biz', 'c', 'cgl', 'ck', 'cm', 'co', 'd', 'diy', 'e', 'f', 'fa', 'fit', 'g', 'gd', 'gif', 'h', 'hc', 'his', 'hm', 'hr', 'i', 'ic', 'int', 'jp', 'k', 'lgbt', 'lit', 'm', 'mlp', 'mlpol', 'mu', 'n', 'news', 'o', 'out', 'p', 'po', 'pol', 'pw', 'q', 'qa', 'qst', 'r', 'r9k', 's', 's4s', 'sci', 'soc', 'sp', 't', 'tg', 'toy', 'trash', 'trv', 'tv', 'u', 'v', 'vg', 'vip', 'vm', 'vmg', 'vp', 'vr', 'vrpg', 'vst', 'vt', 'w', 'wg', 'wsg', 'wsr', 'x', 'xs', 'y'] }
  ];
  const SUPPORTED_BOARDS = Array.from(new Set(ARCHIVE_COVERAGE.flatMap((a) => a.boards))).sort();
  // Per-board overrides for hosts that are technically available but noisy or
  // worse as a first choice. /mlp/ has B4K and archived.moe coverage; keep Desu
  // as a fallback because it rate-limits heavily under replay load.
  const BOARD_ARCHIVE_PREFERENCE = {
    mlp: [B4K, MOE, DESU]
  };

  // Archives that adopted a board late hold none of its older history —
  // querying them for replay dates before they started wastes the opening
  // request of every single fetch on a guaranteed 404.
  const ARCHIVE_BOARD_SINCE = {
    [B4K]: { mlp: Date.UTC(2021, 0, 1) }
  };
  function archiveCoversReplayDate(base, board) {
    const since = ARCHIVE_BOARD_SINCE[base] && ARCHIVE_BOARD_SINCE[base][board];
    if (!since) return true;
    const d = replayDateMs();
    return !Number.isFinite(d) || d >= since;
  }
  // Every archive that hosts this board, best first. Falls back to archived.moe
  // for an unrecognised board rather than fanning out to everything blindly.
  function archivesForBoard(board) {
    const hosts = ARCHIVE_COVERAGE.filter((a) => a.boards.includes(board)).map((a) => a.base)
      .filter((base) => archiveCoversReplayDate(base, board));
    if (!hosts.length) return [MOE];
    const preferred = BOARD_ARCHIVE_PREFERENCE[board] || [];
    if (!preferred.length) return hosts;
    const front = preferred.filter((base) => hosts.includes(base));
    const rest = hosts.filter((base) => !front.includes(base));
    return [...front, ...rest];
  }
  // Some archives expose thread/post/media APIs for a board but disable the
  // path-style HTML search page used for date catalog enumeration.
  const HTML_SEARCH_DISABLED = {
    [B4K]: ['g', 'mlp']
  };
  function htmlSearchEnabled(base, board) {
    return !((HTML_SEARCH_DISABLED[base] || []).includes(board));
  }
  function searchArchivesForBoard(board) {
    const hosts = archivesForBoard(board).filter((base) => htmlSearchEnabled(base, board));
    return hosts.length ? hosts : archivesForBoard(board);
  }
  const archiveFor = (board) => archivesForBoard(board)[0];
  const archiveAPIsFor = (board) => archivesForBoard(board);
  // Thread fetches shard across archives by thread number: hydrating a
  // catalog is dozens of fetches, and splitting them halves the load each
  // host sees. Failover order is preserved — just the starting host rotates.
  const threadAPIsFor = (board, num) => {
    const hosts = archivesForBoard(board);
    if (hosts.length < 2 || num == null) return hosts;
    const i = (Number(String(num).slice(-4)) || 0) % hosts.length;
    return [...hosts.slice(i), ...hosts.slice(0, i)];
  };

  const BOARD_NAMES = {
    3: '3DCG',
    a: 'Anime & Manga', aco: 'Adult Cartoons', adv: 'Advice', an: 'Animals & Nature',
    b: 'Random', bant: 'International/Random', biz: 'Business & Finance',
    c: 'Anime/Cute', cgl: 'Cosplay & EGL', ck: 'Food & Cooking', cm: 'Cute/Male',
    co: 'Comics & Cartoons', con: 'Conventions', d: 'Hentai/Alternative',
    diy: 'Do-It-Yourself', e: 'Ecchi', f: 'Flash', fa: 'Fashion', fit: 'Fitness',
    g: 'Technology', gd: 'Graphic Design', gif: 'Adult GIF', h: 'Hentai',
    hc: 'Hardcore', his: 'History & Humanities', hm: 'Handsome Men', hr: 'High Resolution',
    i: 'Oekaki', ic: 'Artwork/Critique', int: 'International', jp: 'Otaku Culture',
    k: 'Weapons', lgbt: 'LGBT', lit: 'Literature', m: 'Mecha', mlp: 'Pony',
    mlpol: 'Pony Politically Incorrect', mu: 'Music', n: 'Transportation',
    news: 'Current News', o: 'Auto', out: 'Outdoors', p: 'Photography',
    po: 'Papercraft & Origami', pol: 'Politically Incorrect', pw: 'Professional Wrestling',
    q: '4chan Feedback', qa: 'Question & Answer', qst: 'Quests', r: 'Adult Requests',
    r9k: 'ROBOT9001', s: 'Sexy Beautiful Women', s4s: 'Shit 4chan Says',
    sci: 'Science & Math', soc: 'Cams & Meetups', sp: 'Sports', t: 'Torrents',
    tg: 'Traditional Games', toy: 'Toys', trash: 'Off-topic', trv: 'Travel',
    tv: 'Television & Film', u: 'Yuri', v: 'Video Games', vg: 'Video Game Generals',
    vip: 'Very Important Posts', vm: 'Video Games/Multiplayer', vmg: 'Video Games/Mobile',
    vp: 'Pokemon', vr: 'Retro Games', vrpg: 'Video Games/RPG', vst: 'Video Games/Strategy',
    vt: 'Virtual YouTubers', w: 'Anime/Wallpapers', wg: 'Wallpapers/General',
    wsg: 'Worksafe GIF', wsr: 'Worksafe Requests', x: 'Paranormal', xs: 'Extreme Sports',
    y: 'Yaoi'
  };

  // The real 4chan top board list, grouped exactly as 4chan bracketed it.
  const BOARD_NAV = [
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'gif', 'h', 'hr', 'k', 'm', 'o', 'p', 'r', 's', 't', 'u', 'v', 'vg', 'vm', 'vmg', 'vr', 'vrpg', 'vst', 'w', 'wg'],
    ['i', 'ic'],
    ['r9k', 's4s', 'vip', 'cm', 'hm', 'lgbt', 'y'],
    ['3', 'aco', 'adv', 'an', 'bant', 'biz', 'cgl', 'ck', 'co', 'diy', 'fa', 'fit', 'gd', 'hc', 'his', 'int', 'jp', 'lit', 'mlp', 'mu', 'n', 'news', 'out', 'po', 'pol', 'pw', 'qst', 'sci', 'soc', 'sp', 'tg', 'toy', 'trv', 'tv', 'vp', 'vt', 'wsg', 'wsr', 'x', 'xs']
  ];
  const NAV_BOARD_SET = new Set(BOARD_NAV.flat());
  const ARCHIVE_ONLY_BOARD_NAV = SUPPORTED_BOARDS.filter((b) => !NAV_BOARD_SET.has(b));
  const BOARD_NAV_GROUPS = ARCHIVE_ONLY_BOARD_NAV.length ? [...BOARD_NAV, ARCHIVE_ONLY_BOARD_NAV] : BOARD_NAV;

  // ── Tiny utilities ─────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const nextDay = (d) => {
    const [y, m, dd] = d.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd + 1));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  };
  const addDays = (d, days) => {
    const [y, m, dd] = d.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, dd + days));
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  };
  const easternClock = (unixSec) =>
    new Date(unixSec * 1000).toLocaleString('en-US', {
      timeZone: 'America/New_York', weekday: 'short', year: 'numeric',
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

  // 4chan-style post stamp, but with seconds (4chan only showed HH:MM):
  // M/D/YY(Ddd)HH:MM:SS in US Eastern. Reuses one formatter for speed.
  const _etFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: '2-digit', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  function fourchanStamp(unixSec) {
    const parts = _etFmt.formatToParts(new Date(unixSec * 1000));
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    let hh = g('hour'); if (hh === '24') hh = '00';
    // Replay stamps include seconds so posts arriving in the same minute are ordered visibly.
    return `${g('month')}/${g('day')}/${g('year')}(${g('weekday')})${hh}:${g('minute')}:${g('second')}`;
  }

  // ── Network (CORS-free via GM) ───────────────────────────────────────────
  function okStatus(status) {
    return !status || (status >= 200 && status < 300);
  }
  function statusError(r, url) {
    return new Error(`HTTP ${r.status || 0}: ${url}`);
  }
  // ── Rate-limit detection & backoff ─────────────────────────────────────
  // Archives (desuarchive especially) 429 bursts of API calls. The defense
  // has two layers: a per-host concurrency gate that keeps us from bursting
  // in the first place, and a shared per-host cooldown when the server
  // pushes back anyway. Status is shown in the control bar (#wb-ratelimit).
  // Generic 5xx responses are not rate limits (desuarchive often clears a
  // transient 503 on an immediate refresh) but they do get a short shared
  // pause so concurrent workers don't collectively hammer a struggling host.
  const _rateLimits = new Map(); // host -> { until }, true 429/explicit throttle only
  const _hostPauses = new Map();  // host -> { until }, short generic 5xx backoff, not a rate-limit verdict
  // Retrying a host that just said "slow down" is the worst response when
  // mirror archives exist — one retry, then throw so callers fail over.
  const RATE_LIMIT_MAX_RETRIES = 1;
  const TRANSIENT_STATUS_MAX_RETRIES = 2;
  const GM_GET_MAX_WAIT_MS = 35000; // total budget incl. cooldowns — fail over to the next archive rather than sleep forever

  // Per-host concurrency gate. Board loads fan out dozens of API calls; the
  // gate caps simultaneous in-flight requests per host so the burst that
  // trips the limiter never happens. Slots are held through cooldown sleeps
  // on purpose — that's what makes the backoff collective. archive.org
  // serves bulk downloads and tolerates more parallelism than the FoolFuuka
  // archives, whose limiters watch API traffic closely.
  function hostMaxConcurrent(host) {
    return /(^|\.)archive\.org$/i.test(host) ? 4 : 2;
  }

  // Per-host pacing: requests reserve evenly-spaced send slots (sync, so no
  // race between concurrent reservers). Bursts are what trip archive
  // limiters — but every host's budget is different and undocumented, so
  // spacing is LEARNED: widen sharply when a host pushes back (429), ease
  // slowly after sustained success, and persist the result across sessions
  // so a new visit doesn't have to re-trip the limiter to rediscover it.
  const HOST_SPACING_DEFAULTS = [
    [/(^|\.)desuarchive\.org$/i, 900],   // known strict
    [/(^|\.)archived\.moe$/i, 600],
    [/(^|\.)archive\.org$/i, 150]        // bulk host, no fussy limiter
  ];
  const HOST_SPACING_FALLBACK = 300;
  const HOST_SPACING_MIN = 250;
  const HOST_SPACING_MAX = 5000;
  const HOST_SPACING_TIGHTEN_EVERY = 25; // consecutive OKs before easing
  function hostSpacingDefault(host) {
    for (const [re, ms] of HOST_SPACING_DEFAULTS) if (re.test(host)) return ms;
    return HOST_SPACING_FALLBACK;
  }
  let _hostPacing = null; // host → { ms, okStreak }, lazy-loaded from GM storage
  function hostPacing(host) {
    if (!_hostPacing) {
      _hostPacing = new Map();
      try {
        const saved = JSON.parse(GM_getValue('hostPacing:v1', 'null')) || {};
        for (const h of Object.keys(saved)) {
          const ms = Number(saved[h]);
          if (ms > 0) _hostPacing.set(h, { ms: Math.min(HOST_SPACING_MAX, ms), okStreak: 0 });
        }
      } catch (e) { /* fresh start */ }
    }
    let p = _hostPacing.get(host);
    if (!p) { p = { ms: hostSpacingDefault(host), okStreak: 0 }; _hostPacing.set(host, p); }
    return p;
  }
  let _hostPacingSaveTimer = 0;
  function persistHostPacing() {
    if (_hostPacingSaveTimer) return;
    _hostPacingSaveTimer = setTimeout(() => {
      _hostPacingSaveTimer = 0;
      const out = {};
      for (const [h, p] of _hostPacing || []) {
        if (Math.round(p.ms) !== hostSpacingDefault(h)) out[h] = Math.round(p.ms);
      }
      try { GM_setValue('hostPacing:v1', JSON.stringify(out)); } catch (e) { /* storage unavailable */ }
    }, 2000);
  }
  function widenHostSpacing(host) {
    const p = hostPacing(host);
    p.ms = Math.min(HOST_SPACING_MAX, Math.max(p.ms * 1.8, hostSpacingDefault(host)));
    p.okStreak = 0;
    persistHostPacing();
  }
  function noteHostSuccess(host) {
    const p = hostPacing(host);
    if (++p.okStreak < HOST_SPACING_TIGHTEN_EVERY) return;
    p.okStreak = 0;
    // Ease toward (but never much below) the host's default — defaults
    // already encode "known strict"; learning may relax them somewhat.
    const floor = Math.max(HOST_SPACING_MIN, hostSpacingDefault(host) * 0.6);
    const next = Math.max(floor, p.ms * 0.93);
    if (Math.round(next) !== Math.round(p.ms)) { p.ms = next; persistHostPacing(); }
  }
  const _hostNextSlot = new Map(); // host → earliest allowed send time
  function reserveHostSlot(host) {
    const now = Date.now();
    const at = Math.max(now, _hostNextSlot.get(host) || 0);
    _hostNextSlot.set(host, at + hostPacing(host).ms);
    return at - now; // ms this caller must wait before sending
  }
  const _hostGates = new Map(); // host → { active, queue }
  function hostGateAcquire(host) {
    let g = _hostGates.get(host);
    if (!g) { g = { active: 0, queue: [] }; _hostGates.set(host, g); }
    if (g.active < hostMaxConcurrent(host)) { g.active++; return Promise.resolve(); }
    return new Promise((res) => g.queue.push(res));
  }
  function hostGateRelease(host) {
    const g = _hostGates.get(host);
    if (!g) return;
    const next = g.queue.shift();
    if (next) next();
    else g.active = Math.max(0, g.active - 1);
  }

  function responseHeader(headers, name) {
    const re = new RegExp('(?:^|\\n)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*([^\\r\\n]+)', 'i');
    const m = re.exec(headers || '');
    return m ? m[1].trim() : '';
  }
  function retryAfterMs(responseHeaders) {
    const v = responseHeader(responseHeaders, 'retry-after');
    if (!v) return 0;
    const seconds = Number(v);
    if (seconds > 0 && seconds <= 120) return seconds * 1000;
    const ts = Date.parse(v);
    const ms = ts - Date.now();
    return ms > 0 && ms <= 120000 ? ms : 0;
  }
  function rateLimitResponseReason(r) {
    if (r.status === 429) return 'http 429';
    // Cloudflare-style "you are being rate limited" pages come back 403.
    // 5xx pages mentioning rate limiting stay on the transient path — a
    // server error page quoting the words is not a limiter verdict.
    if (r.status !== 403) return '';
    const text = String(r.responseText || '').slice(0, 2048);
    const m = /\b(?:too many requests|rate[-\s]?limit(?:ed|ing)?|throttled)\b/i.exec(text);
    return m ? `http 403 body matched "${m[0].slice(0, 80)}"` : '';
  }
  function transientRetryMs(responseHeaders, attempt) {
    const backoff = Math.min(750 * Math.pow(2, attempt), 3000);
    const retryAfter = retryAfterMs(responseHeaders);
    return retryAfter ? Math.min(retryAfter, 3000) : backoff;
  }
  function isTransientStatus(status) {
    return status === 500 || status === 502 || status === 503 || status === 504;
  }

  function extendCooldown(map, host, ms) {
    const prev = map.get(host);
    const until = Date.now() + ms;
    if (!prev || prev.until < until) map.set(host, { until });
  }
  function noteRateLimit(url, responseHeaders, attempt) {
    // Server's Retry-After or exponential 5s/10s/20s/40s — and jitter ON TOP
    // either way, so the herd of parallel requests doesn't share one wake-up
    // instant and re-trip the limiter in lockstep.
    const base = retryAfterMs(responseHeaders) || Math.min(5000 * Math.pow(2, attempt), 60000);
    extendCooldown(_rateLimits, mediaHost(url), base + Math.floor(Math.random() * 4000));
    updateRateLimitUI();
  }
  // Cooldowns are never deleted on success — a lone request finishing cannot
  // vouch for a host other waiters just saw 429; entries simply lapse.
  function cooldownRemaining(map, host) {
    const rl = map.get(host);
    return rl ? Math.max(0, rl.until - Date.now()) : 0;
  }
  function rateLimitRemaining(host) { return cooldownRemaining(_rateLimits, host); }
  function hostPauseRemaining(host) { return cooldownRemaining(_hostPauses, host); }

  // Self-rearming countdown: re-queries the span every tick so it survives
  // renderShell rebuilding the bar, and stops on its own when no cooldown is
  // active (no interval handle to leak).
  let _rlUiArmed = false;
  function updateRateLimitUI() {
    let worst = null;
    for (const [host, rl] of _rateLimits) {
      if (rl.until > Date.now() && (!worst || rl.until > worst.until)) worst = { host, until: rl.until };
    }
    const span = $('#wb-ratelimit');
    if (span) {
      span.textContent = worst
        ? `rate limited by ${worst.host} - retrying in ${Math.max(1, Math.ceil((worst.until - Date.now()) / 1000))}s`
        : '';
    }
    if (worst && !_rlUiArmed) {
      _rlUiArmed = true;
      setTimeout(() => { _rlUiArmed = false; updateRateLimitUI(); }, 1000);
    }
  }

  async function gmGet(url, { timeout = 30000, json = false, maxWaitMs = GM_GET_MAX_WAIT_MS } = {}) {
    const host = mediaHost(url);
    const deadline = Date.now() + maxWaitMs;
    let rlAttempts = 0;
    let transientAttempts = 0;
    await hostGateAcquire(host);
    try {
      for (;;) {
        // Wait out any shared cooldown — with our own jitter so waiters
        // trickle back instead of stampeding — but never past this request's
        // budget: throwing early lets callers fail over to another archive.
        const rateLimitWait = rateLimitRemaining(host);
        const hostPauseWait = hostPauseRemaining(host);
        const cooldown = Math.max(rateLimitWait, hostPauseWait);
        if (cooldown > 0) {
          const wait = cooldown + Math.floor(Math.random() * 2500);
          if (Date.now() + wait > deadline) {
            throw new Error((rateLimitWait >= hostPauseWait ? 'Rate limited' : 'Host temporarily unavailable') + ': ' + url);
          }
          await sleep(wait);
          continue; // cooldown may have been extended while we slept
        }
        const spacing = reserveHostSlot(host);
        if (spacing > 0) await sleep(spacing);
        const r = await new Promise((resolve, reject) => {
          GM_xmlhttpRequest({
            method: 'GET', url, timeout,
            headers: json ? { 'Accept': 'application/json' } : undefined,
            onload: resolve,
            onerror: () => reject(new Error('Network error: ' + url)),
            ontimeout: () => reject(new Error('Timeout: ' + url))
          });
        });
        const rateLimitReason = rateLimitResponseReason(r);
        if (rateLimitReason) {
          mediaDebug('warn', 'api rate-limit detected', {
            source: mediaSourceKind(url),
            host,
            status: r.status || 0,
            reason: rateLimitReason,
            headers: mediaHeaderSummary(r.responseHeaders || ''),
            url
          });
          widenHostSpacing(host);
          if (rlAttempts >= RATE_LIMIT_MAX_RETRIES) throw statusError(r, url);
          noteRateLimit(url, r.responseHeaders, rlAttempts);
          rlAttempts++;
          continue;
        }
        if (isTransientStatus(r.status)) {
          // Short shared pause: every worker hitting this host backs off a
          // beat together instead of independently hammering a 503ing host.
          extendCooldown(_hostPauses, host, 1500 + Math.floor(Math.random() * 1000));
          if (transientAttempts >= TRANSIENT_STATUS_MAX_RETRIES) throw statusError(r, url);
          await sleep(transientRetryMs(r.responseHeaders, transientAttempts));
          transientAttempts++;
          continue;
        }
        if (!okStatus(r.status)) throw statusError(r, url);
        noteHostSuccess(host);
        if (!json) return r.responseText;
        try { return JSON.parse(r.responseText); }
        catch (e) { throw new Error('Bad JSON from ' + url); }
      }
    } finally {
      hostGateRelease(host);
    }
  }
  function gmJSON(url, timeout = 30000) { return gmGet(url, { timeout, json: true }); }
  function gmText(url) { return gmGet(url, { timeout: 40000 }); }
  const MEDIA_TIMEOUT_MS = 5000;
  const MEDIA_ARCHIVE_ORG_TIMEOUT_MS = 12000;
  const MEDIA_BATCH_SIZE = 8;
  const MLP_ARCHIVE_ORG_FIRST_CUTOFF_MS = Date.UTC(2015, 0, 1);
  const _hostFails = new Map();
  const HOST_FAIL_THRESHOLD = 4;
  const HOST_FAIL_WINDOW_MS = 60000;
  function mediaHost(url) { try { return new URL(url).host; } catch (e) { return ''; } }
  function archiveOrgMedia(url) {
    return /\b(?:web\.)?archive\.org\b/i.test(mediaHost(url));
  }
  function replayDateMs() {
    const m = String(CONFIG.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return NaN;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  function mlpArchiveOrgFirstRequired(board = engine.board) {
    const d = replayDateMs();
    return board === 'mlp' && Number.isFinite(d) && d < MLP_ARCHIVE_ORG_FIRST_CUTOFF_MS;
  }
  function mediaCandidateBatchSize() {
    return mlpArchiveOrgFirstRequired() ? 1 : MEDIA_BATCH_SIZE;
  }
  function mediaResolveConcurrencyLimit() {
    const configured = Math.max(1, CONFIG.mediaResolveConcurrency || 1);
    return mlpArchiveOrgFirstRequired() ? 1 : configured;
  }
  function mediaFetchTimeout(url) {
    return archiveOrgMedia(url) ? MEDIA_ARCHIVE_ORG_TIMEOUT_MS : MEDIA_TIMEOUT_MS;
  }
  function trackHostFail(url) {
    // archive.org/Wayback is often slow for a specific object without the whole
    // host being down; don't let a few slow captures suppress all later attempts.
    if (archiveOrgMedia(url)) return;
    const h = mediaHost(url);
    if (!h) return;
    const now = Date.now();
    const fails = (_hostFails.get(h) || []).filter((t) => now - t < HOST_FAIL_WINDOW_MS);
    fails.push(now);
    _hostFails.set(h, fails);
  }
  function hostIsDown(url) {
    if (archiveOrgMedia(url)) return false;
    const h = mediaHost(url);
    if (!h) return false;
    const fails = _hostFails.get(h);
    return fails && fails.filter((t) => Date.now() - t < HOST_FAIL_WINDOW_MS).length >= HOST_FAIL_THRESHOLD;
  }
  // True while any host is rate-limited or marked down — a "this image
  // doesn't exist" verdict reached during a disturbance is not trustworthy
  // and must not be persisted.
  function networkDisturbed() {
    const now = Date.now();
    for (const rl of _rateLimits.values()) {
      if (rl.until > now) return true;
    }
    for (const pause of _hostPauses.values()) {
      if (pause.until > now) return true;
    }
    for (const fails of _hostFails.values()) {
      if (fails.filter((t) => now - t < HOST_FAIL_WINDOW_MS).length >= HOST_FAIL_THRESHOLD) return true;
    }
    return false;
  }
  const _blobCache = new Map();
  const _mediaDebugLog = [];
  const MEDIA_DEBUG_LOG_LIMIT = 500;
  function archiveOrgZipUrl(url) {
    return /^https?:\/\/archive\.org\/download\/4chan-mlp-archive-\d{4}-\d{2}\/\d{4}-\d{2}\.zip\//i.test(url);
  }
  function archiveOrgDirectFileUrl(url) {
    return /^https?:\/\/archive\.org\/download\/4chan-mlp-archive-(?:2012-05|2012-06)\/[^/]+$/i.test(url);
  }
  function archiveOrgMlpRehostUrl(url) {
    return archiveOrgZipUrl(url) || archiveOrgDirectFileUrl(url);
  }
  function mediaSourceKind(url) {
    if (archiveOrgZipUrl(url)) return 'archive.org zip';
    if (archiveOrgDirectFileUrl(url)) return 'archive.org direct';
    if (/^https?:\/\/web\.archive\.org\/web\/2id_\//i.test(url)) return 'wayback raw';
    if (/\barchive\.org\b/i.test(url)) return 'archive.org';
    if (/\bdesuarchive\.org\b|\bdesu-usergeneratedcontent\.xyz\b/i.test(url)) return 'desuarchive';
    if (/\b4plebs\.org\b|\bimg\.4plebs\.org\b/i.test(url)) return '4plebs';
    if (/\barchived\.moe\b/i.test(url)) return 'archived.moe';
    if (/\bi\.4cdn\.org\b|\bimages\.4chan\.org\b/i.test(url)) return '4chan original';
    return mediaHost(url);
  }
  function mediaHeaderSummary(headers) {
    const out = {};
    for (const name of ['content-type', 'content-length', 'content-encoding', 'location', 'server', 'x-archive-orig-content-type']) {
      const v = responseHeader(headers, name);
      if (v) out[name] = v;
    }
    return out;
  }
  function mediaResponseMeta(url, r) {
    const blob = r && r.response;
    return {
      source: mediaSourceKind(url),
      host: mediaHost(url),
      status: (r && r.status) || 0,
      finalUrl: (r && r.finalUrl) || '',
      size: (blob && blob.size) || 0,
      type: (blob && blob.type) || '',
      headers: mediaHeaderSummary((r && r.responseHeaders) || ''),
      url
    };
  }
  function mediaRejectReason(r, type) {
    if (!r) return 'no response';
    if (!(r.status >= 200 && r.status < 300)) return `HTTP ${r.status || 0}`;
    if (!r.response) return 'empty response object';
    if (!r.response.size) return 'empty blob';
    if (type && (type.startsWith('text') || type.includes('html'))) return `non-image content type ${type}`;
    return 'unknown rejection';
  }
  function blobTextSnippet(blob, max = 500) {
    return new Promise((resolve) => {
      if (!blob || !blob.slice || typeof FileReader !== 'function') { resolve(''); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').replace(/\s+/g, ' ').slice(0, max));
      reader.onerror = () => resolve('');
      try { reader.readAsText(blob.slice(0, max)); } catch (e) { resolve(''); }
    });
  }
  function logRejectedMediaResponse(url, r, reason) {
    // Diagnostics off (the default): skip building meta and reading blob
    // bodies — thousands of rejected candidates per board would pay for it.
    if (!CONFIG.mediaDebug) return;
    const meta = { ...mediaResponseMeta(url, r), reason };
    mediaDebug('warn', 'fetch rejected', meta);
    const blob = r && r.response;
    const type = (blob && blob.type) || '';
    if (blob && blob.size && (type.startsWith('text') || type.includes('html') || /archive\.org/i.test(url))) {
      blobTextSnippet(blob).then((snippet) => {
        if (snippet) mediaDebug('warn', 'fetch rejected body snippet', { ...meta, snippet });
      });
    }
  }
  function mediaDebug(level, msg, data = {}) {
    if (!CONFIG.mediaDebug) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      data
    };
    _mediaDebugLog.push(entry);
    if (_mediaDebugLog.length > MEDIA_DEBUG_LOG_LIMIT) _mediaDebugLog.splice(0, _mediaDebugLog.length - MEDIA_DEBUG_LOG_LIMIT);
    try { window.oldchanMediaLog = _mediaDebugLog; } catch (e) { /* window unavailable */ }
    const fn = level === 'warn' ? console.warn : console.debug;
    try { fn.call(console, `[oldchan media] ${msg}`, data); } catch (e) { /* console unavailable */ }
  }
  try {
    window.oldchanMediaLog = _mediaDebugLog;
    window.oldchanMediaDiagnostics = {
      log: _mediaDebugLog,
      enable: () => { CONFIG.mediaDebug = true; saveSettings(); return 'oldchan media diagnostics enabled'; },
      disable: () => { CONFIG.mediaDebug = false; saveSettings(); return 'oldchan media diagnostics disabled'; },
      clear: () => { _mediaDebugLog.length = 0; return 'oldchan media diagnostics cleared'; }
    };
  } catch (e) { /* window unavailable */ }
  const MEDIA_CACHE_NAME = 'oldchan-media-v1';
  const IA_MLP_INDEX_CACHE_NAME = 'oldchan-ia-mlp-index-v1';
  const IA_MLP_INDEX_URL = 'https://archive.org/download/4chan-mlp-archive-index/md5-index.json';
  function mediaCacheAvailable() {
    return !!(CONFIG.mediaPersistentCache && 'caches' in window && window.caches);
  }
  function mediaCacheRequestUrl(url) {
    return `/__oldchan_media_cache__?u=${encodeURIComponent(url)}`;
  }
  let _mediaCacheHandle = null;
  function openMediaCache() {
    return _mediaCacheHandle || (_mediaCacheHandle = caches.open(MEDIA_CACHE_NAME));
  }
  let _iaMlpIndex = null;
  let _iaMlpIndexPromise = null;
  function archiveOrgIndexCacheAvailable() {
    return !!('caches' in window && window.caches);
  }
  async function loadArchiveOrgMlpIndex() {
    if (_iaMlpIndex) return _iaMlpIndex;
    if (_iaMlpIndexPromise) return _iaMlpIndexPromise;
    _iaMlpIndexPromise = (async () => {
      mediaDebug('debug', 'archive.org md5 index load start', { url: IA_MLP_INDEX_URL });
      let cache = null;
      if (archiveOrgIndexCacheAvailable()) {
        try {
          cache = await caches.open(IA_MLP_INDEX_CACHE_NAME);
          const cached = await cache.match(IA_MLP_INDEX_URL);
          if (cached) {
            const data = await cached.json();
            if (data && typeof data === 'object') {
              _iaMlpIndex = data;
              mediaDebug('debug', 'archive.org md5 index cache hit', { url: IA_MLP_INDEX_URL });
              return data;
            }
          }
        } catch (e) {
          mediaDebug('warn', 'archive.org md5 index cache read failed', { error: String(e && e.message || e) });
        }
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 180000) : null;
      let text = '';
      try {
        try {
          const res = await fetch(IA_MLP_INDEX_URL, {
            mode: 'cors',
            credentials: 'omit',
            signal: controller && controller.signal
          });
          if (!res.ok) throw new Error(`HTTP ${res.status || 0}`);
          text = await res.text();
        } catch (e) {
          mediaDebug('warn', 'archive.org md5 index native fetch failed, trying GM', { error: String(e && e.message || e) });
          text = await gmGet(IA_MLP_INDEX_URL, { timeout: 180000, json: false, maxWaitMs: 210000 });
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') throw new Error('index JSON was not an object');
      _iaMlpIndex = data;
      if (cache) {
        try {
          await cache.put(IA_MLP_INDEX_URL, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
        } catch (e) {
          mediaDebug('warn', 'archive.org md5 index cache write failed', { error: String(e && e.message || e) });
        }
      }
      mediaDebug('debug', 'archive.org md5 index loaded', { url: IA_MLP_INDEX_URL, bytes: text.length });
      return data;
    })().catch((e) => {
      _iaMlpIndexPromise = null;
      mediaDebug('warn', 'archive.org md5 index load failed', { url: IA_MLP_INDEX_URL, error: String(e && e.message || e) });
      return null;
    });
    return _iaMlpIndexPromise;
  }
  async function cachedMediaBlobURL(url) {
    if (!mediaCacheAvailable()) return null;
    try {
      const cache = await openMediaCache();
      const res = await cache.match(mediaCacheRequestUrl(url));
      if (!res) return null;
      const blob = await res.blob();
      const t = blob.type || '';
      if (!blob.size || t.startsWith('text') || t.includes('html')) return null;
      mediaDebug('debug', 'persistent media cache hit', { host: mediaHost(url), size: blob.size, type: t, url });
      return URL.createObjectURL(blob);
    } catch (e) {
      mediaDebug('warn', 'persistent media cache read failed', { host: mediaHost(url), url, error: String(e && e.message || e) });
      return null;
    }
  }
  function storeMediaBlob(url, blob) {
    if (!mediaCacheAvailable() || !blob || !blob.size) return;
    const max = Math.max(0, CONFIG.mediaPersistentMaxBytes || 0);
    if (max && blob.size > max) return;
    openMediaCache().then((cache) => {
      const headers = {};
      if (blob.type) headers['Content-Type'] = blob.type;
      return cache.put(mediaCacheRequestUrl(url), new Response(blob, { headers }));
    }).then(() => {
      mediaDebug('debug', 'persistent media cached', { host: mediaHost(url), size: blob.size, type: blob.type, url });
    }, (e) => {
      mediaDebug('warn', 'persistent media cache write failed', { host: mediaHost(url), url, error: String(e && e.message || e) });
    });
  }
  // ── Persistent full-thread cache (browser Cache Storage, like media) ─────
  // GM storage has an 8MB budget, far too small for full thread JSON — but
  // Cache Storage holds gigabytes. Archived threads are immutable (they
  // ended years ago), so an old thread never needs re-fetching; only threads
  // with recent activity get a freshness window.
  const THREAD_CACHE_NAME = 'oldchan-threads-v1';
  const THREAD_IMMUTABLE_AGE_S = 30 * 86400; // last post older than this → thread can never change
  const THREAD_FRESH_MS = 3600 * 1000;       // recent threads: trust cache for 1h
  function threadCacheAvailable() {
    return !!(CONFIG.threadPersistentCache && 'caches' in window && window.caches);
  }
  function threadCacheRequestUrl(board, num) {
    return `/__oldchan_thread_cache__?b=${encodeURIComponent(board)}&n=${encodeURIComponent(num)}`;
  }
  let _threadCacheHandle = null;
  function openThreadCache() {
    return _threadCacheHandle || (_threadCacheHandle = caches.open(THREAD_CACHE_NAME));
  }
  function cachedThreadFromMemory(board, num) {
    if (board !== engine.board) return null;
    const posts = engine.threads.get(String(num));
    return posts && posts.length ? { posts, source: 'memory' } : null;
  }
  async function cachedThreadFull(board, num, opts = {}) {
    if (!threadCacheAvailable()) return null;
    try {
      const cache = await openThreadCache();
      const res = await cache.match(threadCacheRequestUrl(board, num));
      if (!res) return null;
      const data = await res.json();
      if (!data || !validThreadResult(data.result)) return null;
      const fresh = Date.now() - (data.cachedAt || 0) <= THREAD_FRESH_MS;
      // Degraded results (fetched while a better archive was unreachable)
      // are only trusted briefly — they must retry, not pin a bad copy.
      if (data.result.degraded && !fresh && !opts.allowDegraded) return null;
      const lastTs = Number(data.result.posts[data.result.posts.length - 1].ts) || 0;
      const threadAgeS = Date.now() / 1000 - lastTs;
      if (threadAgeS < THREAD_IMMUTABLE_AGE_S && !fresh && !opts.allowStale) return null;
      return {
        ...data.result,
        source: data.result.source || 'thread-cache',
        staleCache: !fresh,
        degraded: !!data.result.degraded
      };
    } catch (e) {
      return null;
    }
  }
  function storeThreadFull(board, num, result) {
    if (!threadCacheAvailable() || !validThreadResult(result)) return;
    // Defer the (potentially multi-MB) stringify off the hydration hot path.
    const write = () => {
      openThreadCache().then((cache) => cache.put(
        threadCacheRequestUrl(board, num),
        new Response(JSON.stringify({ cachedAt: Date.now(), result }),
          { headers: { 'Content-Type': 'application/json' } })
      )).catch(() => { /* quota or private mode — fetch path still works */ });
    };
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(write, { timeout: 4000 });
    else setTimeout(write, 250);
  }

  function gmBlobURL(url) {
    if (hostIsDown(url)) {
      mediaDebug('warn', 'fetch skipped, host marked down', { source: mediaSourceKind(url), host: mediaHost(url), url });
      return Promise.resolve(null);
    }
    if (_blobCache.has(url)) {
      mediaDebug('debug', 'fetch promise cache hit', { source: mediaSourceKind(url), host: mediaHost(url), url });
      return _blobCache.get(url);
    }
    const p = (async () => {
      const cached = await cachedMediaBlobURL(url);
      if (cached) return cached;
      return new Promise((resolve) => {
        const timeout = mediaFetchTimeout(url);
        mediaDebug('debug', 'fetch start', { source: mediaSourceKind(url), host: mediaHost(url), timeout, url });
        GM_xmlhttpRequest({
          method: 'GET', url, responseType: 'blob', timeout,
          onload: (r) => {
            const t = (r.response && r.response.type) || '';
            const ok = r.status >= 200 && r.status < 300 && r.response && r.response.size > 0 &&
              !t.startsWith('text') && !t.includes('html');
            if (!ok) {
              logRejectedMediaResponse(url, r, mediaRejectReason(r, t));
              resolve(null);
              return;
            }
            if (CONFIG.mediaDebug) mediaDebug('debug', 'fetch ok', mediaResponseMeta(url, r));
            storeMediaBlob(url, r.response);
            resolve(URL.createObjectURL(r.response));
          },
          onerror: (e) => {
            trackHostFail(url);
            mediaDebug('warn', 'fetch network error', { source: mediaSourceKind(url), host: mediaHost(url), url, error: String(e && e.message || e || '') });
            resolve(null);
          },
          ontimeout: () => {
            trackHostFail(url);
            mediaDebug('warn', 'fetch timeout', { source: mediaSourceKind(url), host: mediaHost(url), timeout, url });
            resolve(null);
          }
        });
      });
    })();
    _blobCache.set(url, p);
    return p;
  }

  const _mediaTaskQueue = [];
  let _mediaTaskActive = 0;
  function drainMediaTasks() {
    const max = mediaResolveConcurrencyLimit();
    while (_mediaTaskActive < max && _mediaTaskQueue.length) {
      const task = _mediaTaskQueue.shift();
      _mediaTaskActive++;
      Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(() => {
        _mediaTaskActive--;
        drainMediaTasks();
      });
    }
  }
  function enqueueMediaTask(run) {
    return new Promise((resolve, reject) => {
      _mediaTaskQueue.push({ run, resolve, reject });
      drainMediaTasks();
    });
  }

  let _lazyMediaObserver = null;
  let _lazyMediaRoot = null;
  const _lazyMediaJobs = new WeakMap();
  function runLazyMediaJob(target) {
    const job = _lazyMediaJobs.get(target);
    if (!job || job.started) return;
    job.started = true;
    _lazyMediaJobs.delete(target);
    if (_lazyMediaObserver) {
      try { _lazyMediaObserver.unobserve(target); } catch (e) { /* observer already gone */ }
    }
    enqueueMediaTask(job.run);
  }
  function lazyMediaObserver() {
    const root = $('#wb-overlay') || null;
    if (_lazyMediaObserver && _lazyMediaRoot === root) return _lazyMediaObserver;
    if (_lazyMediaObserver) _lazyMediaObserver.disconnect();
    _lazyMediaRoot = root;
    _lazyMediaObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting || entry.intersectionRatio > 0) runLazyMediaJob(entry.target);
      }
    }, { root, rootMargin: '1200px 0px', threshold: 0 });
    return _lazyMediaObserver;
  }
  function lazyMedia(target, run) {
    if (!target || !('IntersectionObserver' in window)) {
      enqueueMediaTask(run);
      return;
    }
    _lazyMediaJobs.set(target, { run, started: false });
    setTimeout(() => {
      if (!_lazyMediaJobs.has(target)) return;
      try { lazyMediaObserver().observe(target); }
      catch (e) { runLazyMediaJob(target); }
    }, 0);
  }
  function lazyResolvePostMedia(target, p, kind, onOk, onMiss) {
    lazyMedia(target, async () => {
      if (target && !target.isConnected) await sleep(0);
      if (target && !target.isConnected) return null;
      const r = await postMediaBlob(p, kind);
      if (target && !target.isConnected) return r;
      if (r) onOk(r);
      else if (onMiss) onMiss();
      return r;
    });
  }

  // Across FoolFuuka-compatible archives an image's path is identical except for the host:
  // /{board}/{image|thumb}/{tim[0:4]}/{tim[4:6]}/{file}. So if one host has lost
  // a file, try the same path only on archives that actually host the board.
  const uniq = (items) => {
    const seen = new Set();
    return items.filter((x) => {
      if (!x || seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  };
  function absArchiveUrl(base, url) {
    if (!url) return '';
    if (/^\/\//.test(url)) return 'https:' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return base ? base.replace(/\/$/, '') + '/' + String(url).replace(/^\//, '') : url;
  }
  function filenameFromUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(absArchiveUrl('', url), location.href);
      return decodeURIComponent((u.pathname.split('/').pop() || '').replace(/\+/g, ' '));
    } catch (e) {
      return String(url).split(/[?#]/)[0].split('/').pop() || '';
    }
  }
  function mediaLabel(media) {
    return (media && (media.fname || media.mediaFilenameProcessed || media.mediaFilename ||
      filenameFromUrl(media.full) || filenameFromUrl(media.thumb))) || 'image';
  }

  const mediaFromApi = (m, base = '', board = '') => {
    if (!m) return null;
    const mediaLink = absArchiveUrl(base, m.media_link);
    const remoteMediaLink = absArchiveUrl(base, m.remote_media_link);
    const thumbLink = absArchiveUrl(base, m.thumb_link);
    const mediaFilename = m.media_filename || '';
    const mediaFilenameProcessed = m.media_filename_processed || '';
    const rawHash = validMediaHash(m.media_hash) ? m.media_hash : '';
    const safeHash = validMediaHash(m.safe_media_hash) ? m.safe_media_hash : '';
    return {
      thumb: thumbLink,
      full: mediaLink || remoteMediaLink,
      fname: mediaFilenameProcessed || mediaFilename ||
        filenameFromUrl(mediaLink || remoteMediaLink || thumbLink),
      meta: (m.media_w && m.media_h) ? `${m.media_w}x${m.media_h}` : '',
      hash: safeHash || normalizedHash(rawHash),
      rawHash,
      board,
      sourceBase: base,
      mediaId: m.media_id || '',
      spoiler: m.spoiler || '',
      mediaStatus: m.media_status || '',
      banned: m.banned || '',
      total: m.total || '',
      archiveMedia: m.media || '',
      mediaOrig: m.media_orig || '',
      previewOrig: m.preview_orig || '',
      previewOp: m.preview_op || '',
      previewReply: m.preview_reply || '',
      mediaFilename,
      mediaFilenameProcessed,
      mediaW: m.media_w || '',
      mediaH: m.media_h || '',
      mediaSize: m.media_size || '',
      previewW: m.preview_w || '',
      previewH: m.preview_h || '',
      mediaLink,
      remoteMediaLink,
      thumbLink
    };
  };

  function archiveMediaPathCandidates(base, board, kind, path, file) {
    const out = [];
    if (base === DESU) {
      out.push(`https://desu-usergeneratedcontent.xyz/${path}`);
    } else if (base === B4K) {
      out.push(`https://arch.b4k.dev/media/${path}`);
      out.push(`https://arch-img.b4k.dev/${path}`);
      out.push(`https://arch-img.b4k.co/${path}`);
    } else if (base === MOE) {
      out.push(`https://archived.moe/files/${path}`);
    } else if (base === PALANQ) {
      out.push(`https://archive-media.palanq.win/${path}`);
    } else if (base === ALICE) {
      out.push(`https://archive.alice.al/foolfuuka/boards/${path}`);
    } else if (base === PLEBS) {
      out.push(`https://img.4plebs.org/boards/${path}`);
      out.push(`https://archive.4plebs.org/boards/${path}`);
      out.push(`https://archive.4plebs.org/${path}`);
    } else if (base === SINS) {
      out.push(`https://archiveofsins.com/data/${path}`);
      out.push(`https://archiveofsins.com/${path}`);
    } else if (base === THEB) {
      out.push(`https://thebarchive.com/data/${path}`);
      out.push(`https://thebarchive.com/${path}`);
    } else if (base === EIENTEI) {
      out.push(`https://eientei.xyz/data/${path}`);
      out.push(`https://eientei.xyz/${path}`);
    }

    if (kind !== 'image') return out;
    if (base === DESU) {
      out.push(`https://desuarchive.org/${board}/redirect/${file}`);
      out.push(`https://desuarchive.org/${board}/image/${file}`);
    } else if (base === B4K) {
      out.push(`https://arch.b4k.dev/${board}/image/${file}`);
      out.push(`https://arch.b4k.co/${board}/image/${file}`);
      out.push(`https://arch-img.b4k.dev/${board}/image/${file}`);
      out.push(`https://arch-img.b4k.co/${board}/image/${file}`);
    } else if (base === MOE) {
      out.push(`https://archived.moe/${board}/redirect/${file}`);
      out.push(`https://archived.moe/${board}/image/${file}`);
    } else if (base === ALICE) {
      out.push(`https://archive.alice.al/${board}/redirect/${file}`);
    } else if (base === PALANQ) {
      out.push(`https://archive.palanq.win/${board}/redirect/${file}`);
    } else if (base === PLEBS) {
      out.push(`https://archive.4plebs.org/${board}/redirect/${file}`);
    } else if (base === SINS) {
      out.push(`https://archiveofsins.com/${board}/redirect/${file}`);
    } else if (base === THEB) {
      out.push(`https://thebarchive.com/${board}/redirect/${file}`);
    } else if (base === EIENTEI) {
      out.push(`https://eientei.xyz/${board}/redirect/${file}`);
    }
    return out;
  }

  function mediaPathCandidates(board, kind, a, b, file) {
    const path = `${board}/${kind}/${a}/${b}/${file}`;
    return uniq(archivesForBoard(board).flatMap((base) => (
      archiveMediaPathCandidates(base, board, kind, path, file)
    )));
  }
  function timPathParts(file) {
    const m = String(file || '').match(/^(\d{4})(\d{2})\d*\.[a-z0-9]+$/i);
    return m ? [m[1], m[2]] : null;
  }
  function mediaFilePathCandidates(board, kind, file) {
    const parts = timPathParts(filenameFromUrl(file));
    return parts ? mediaPathCandidates(board, kind, parts[0], parts[1], filenameFromUrl(file)) : [];
  }
  function thumbNameFromImage(file) {
    const f = filenameFromUrl(file);
    if (!f) return '';
    return f.replace(/\.[^.]+$/, 's.jpg');
  }
  function originalFourcdnCandidates(board, file) {
    const f = filenameFromUrl(file);
    return timPathParts(f) ? [
      `https://i.4cdn.org/${board}/${f}`,
      `https://images.4chan.org/${board}/${f}`,
      `http://images.4chan.org/${board}/${f}`
    ] : [];
  }
  // Wayback Machine: try every known original URL format through archive.org.
  // The /web/2id_/ prefix returns the raw file from the nearest snapshot.
  function waybackCandidates(board, file) {
    const f = filenameFromUrl(file);
    if (!f || !timPathParts(f)) return [];
    const stem = f.replace(/\.[^.]+$/, '');
    return [
      `https://web.archive.org/web/2id_/https://i.4cdn.org/${board}/${f}`,
      `https://web.archive.org/web/2id_/http://i.4cdn.org/${board}/${f}`,
      `https://web.archive.org/web/2id_/https://images.4chan.org/${board}/src/${f}`,
      `https://web.archive.org/web/2id_/http://images.4chan.org/${board}/src/${f}`,
      `https://web.archive.org/web/2id_/https://i.4cdn.org/${board}/${stem}s.jpg`,
    ];
  }
  function waybackThumbCandidates(board, file) {
    const f = filenameFromUrl(file);
    if (!f || !timPathParts(f)) return [];
    const stem = f.replace(/\.[^.]+$/, '');
    return [
      `https://web.archive.org/web/2id_/https://i.4cdn.org/${board}/${stem}s.jpg`,
      `https://web.archive.org/web/2id_/http://i.4cdn.org/${board}/${stem}s.jpg`,
      `https://web.archive.org/web/2id_/https://images.4chan.org/${board}/thumb/${stem}s.jpg`,
      `https://web.archive.org/web/2id_/http://images.4chan.org/${board}/thumb/${stem}s.jpg`,
    ];
  }
  // Extra archives not in the FoolFuuka routing table but that still serve images.
  const EXTRA_IMAGE_ARCHIVES = {
    warosu: { host: 'fuuka.warosu.org/data', boards: ['jp', 'vr', 'g', 'ck', 'lit', 'sci', 'tg', 'ic', 'cgl', 'fa'] },
    fireden: { host: 'boards.fireden.net/data', boards: ['a', 'cm', 'ic', 'sci', 'tg', 'v', 'vg', 'y'] },
    rbt: { host: 'rbt.asia/data', boards: ['g', 'mu', 'cgl'] },
  };
  function extraArchiveCandidates(board, kind, file) {
    const f = filenameFromUrl(file);
    const parts = timPathParts(f);
    if (!f || !parts) return [];
    const out = [];
    for (const arc of Object.values(EXTRA_IMAGE_ARCHIVES)) {
      if (!arc.boards.includes(board)) continue;
      out.push(`https://${arc.host}/${board}/${kind}/${parts[0]}/${parts[1]}/${f}`);
    }
    return out;
  }
  function imageCandidates(url) {
    if (!url) return [];
    const m = url.match(/^https?:\/\/[^/]+\/(?:(?:files|media|boards|data|foolfuuka\/boards)\/)?([a-z0-9]+)\/(image|thumb)\/(\d+)\/(\d+)\/([^/?#]+)$/i);
    if (m) return uniq([url, ...mediaPathCandidates(m[1], m[2], m[3], m[4], m[5])]);
    const flat = url.match(/^https?:\/\/[^/]+\/([a-z0-9]+)\/(?:image|redirect)\/([^/?#]+)$/i);
    const parts = flat && flat[2].match(/^(\d{4})(\d{2})/);
    if (flat && parts) return uniq([url, ...mediaPathCandidates(flat[1], 'image', parts[1], parts[2], flat[2])]);
    return [url]; // unknown layout (e.g. 4plebs)
  }
  function thumbCandidatesFromFull(url) {
    const m = url && url.match(/^https?:\/\/[^/]+\/(?:(?:files|media|boards|data|foolfuuka\/boards)\/)?([a-z0-9]+)\/image\/(\d+)\/(\d+)\/([^/?#]+)$/i);
    if (m) {
      const stem = m[4].replace(/\.[^.]+$/, '');
      return mediaPathCandidates(m[1], 'thumb', m[2], m[3], `${stem}s.jpg`);
    }
    const flat = url && url.match(/^https?:\/\/[^/]+\/([a-z0-9]+)\/(?:image|redirect)\/([^/?#]+)$/i);
    const parts = flat && flat[2].match(/^(\d{4})(\d{2})/);
    if (!flat || !parts) return [];
    const stem = flat[2].replace(/\.[^.]+$/, '');
    return mediaPathCandidates(flat[1], 'thumb', parts[1], parts[2], `${stem}s.jpg`);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function firstSuccess(promises) {
    const live = promises.filter(Boolean);
    if (!live.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let pending = live.length, done = false;
      live.forEach((p) => Promise.resolve(p).then((r) => {
        if (done) return;
        if (r) { done = true; resolve(r); }
        else if (--pending === 0) resolve(null);
      }, () => {
        if (!done && --pending === 0) resolve(null);
      }));
    });
  }
  async function firstBlobBatch(urls) {
    return firstSuccess(urls.map((u) => gmBlobURL(u).then((b) => b ? { blob: b, url: u } : null)));
  }

  // Resolve to the first candidate that actually loads. Candidates are normally
  // probed in small parallel batches so one dead host cannot stall the whole
  // chain. /mlp/ before 2015 is stricter: batch size 1, with archive.org tried
  // before any mirror image host.
  async function firstBlob(urls) {
    const unique = uniq(urls);
    if (!unique.length) {
      mediaDebug('debug', 'candidate list empty');
      return null;
    }
    mediaDebug('debug', 'candidate list', { count: unique.length, urls: unique });
    const batchSize = mediaCandidateBatchSize();
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      mediaDebug('debug', 'candidate batch', { start: i, size: batch.length, urls: batch });
      const found = await firstBlobBatch(batch);
      if (found) {
        mediaDebug('debug', 'candidate selected', { url: found.url, batchStart: i });
        return found;
      }
    }
    mediaDebug('warn', 'all candidates failed', { count: unique.length, urls: unique });
    return null;
  }

  const _postMediaCache = new Map();
  async function postArchiveMedia(board, num) {
    const key = `${board}:${num}`;
    if (_postMediaCache.has(key)) return _postMediaCache.get(key);
    const p = (async () => {
      const readOne = async (base) => {
        const url = `${base}/_/api/chan/post/?board=${board}&num=${num}`;
        let data;
        try { data = await gmJSON(url, 8000); }
        catch (e) { mediaDebug('warn', 'post API failed', { board, num, base, url, error: String(e && e.message || e) }); return null; }
        return mediaFromApi(data && data.media, base, board);
      };
      const usable = (m) => m && (m.thumb || m.full || mediaHashes(m).length);
      let found;
      if (mlpArchiveOrgFirstRequired(board)) {
        found = [];
        for (const base of archiveAPIsFor(board)) {
          const m = await readOne(base);
          if (!usable(m)) continue;
          found.push(m);
          mediaDebug('debug', 'post API media sequential hit', { board, num, base, hash: firstMediaHash([m]) });
          break;
        }
      } else {
        found = await Promise.all(archiveAPIsFor(board).map(readOne));
      }
      const media = found.filter(usable);
      mediaDebug(media.length ? 'debug' : 'warn', 'post API media results', { board, num, count: media.length, media });
      if (!media.length) _postMediaCache.delete(key);
      return media;
    })();
    _postMediaCache.set(key, p);
    return p;
  }

  function normalizedHash(h) {
    return h ? String(h).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-') : '';
  }
  // Compact MD5 for verifying image blobs against archive media_hash.
  const md5Binary = (() => {
    const k = [], s = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
    for (let i = 0; i < 64; i++) k[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    const r = (n, c) => (n << c) | (n >>> (32 - c));
    return (buf) => {
      const bytes = new Uint8Array(buf);
      const len = bytes.length;
      const padded = new Uint8Array((((len + 8) >>> 6) + 1) << 6);
      padded.set(bytes);
      padded[len] = 0x80;
      const dv = new DataView(padded.buffer);
      dv.setUint32(padded.length - 8, (len * 8) >>> 0, true);
      dv.setUint32(padded.length - 4, (len * 8) / 0x100000000 >>> 0, true);
      let a0 = 0x67452301, b0 = 0xEFCDAB89, c0 = 0x98BADCFE, d0 = 0x10325476;
      for (let off = 0; off < padded.length; off += 64) {
        const m = [];
        for (let j = 0; j < 16; j++) m[j] = dv.getUint32(off + j * 4, true);
        let a = a0, b = b0, c = c0, d = d0;
        for (let i = 0; i < 64; i++) {
          let f, g;
          if (i < 16) { f = (b & c) | (~b & d); g = i; }
          else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
          else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
          else { f = c ^ (b | ~d); g = (7 * i) % 16; }
          const tmp = d; d = c; c = b;
          b = (b + r((a + f + k[i] + m[g]) >>> 0, s[(i >>> 4) * 4 + (i % 4)])) >>> 0;
          a = tmp;
        }
        a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
      }
      const out = new Uint8Array(16);
      [a0, b0, c0, d0].forEach((v, i) => {
        out[i * 4] = v & 0xFF; out[i * 4 + 1] = (v >>> 8) & 0xFF;
        out[i * 4 + 2] = (v >>> 16) & 0xFF; out[i * 4 + 3] = (v >>> 24) & 0xFF;
      });
      return out;
    };
  })();
  function md5Base64(buf) {
    const bytes = md5Binary(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  async function verifyBlobHash(blobUrl, expectedHash) {
    if (!expectedHash || !blobUrl) return true;
    try {
      const res = await fetch(blobUrl);
      const buf = await res.arrayBuffer();
      const actual = md5Base64(buf);
      const match = normalizedHash(actual) === normalizedHash(expectedHash);
      if (!match) mediaDebug('warn', 'hash mismatch', { expected: expectedHash, actual });
      return match;
    } catch (e) {
      // Fail CLOSED: an unreadable blob (e.g. a revoked object URL) must not
      // pass as verified — failing open let dead URLs render as images.
      mediaDebug('warn', 'hash verification unreadable, rejecting', { error: String(e && e.message || e) });
      return false;
    }
  }
  function mediaHashes(m) {
    return uniq([
      m && m.hash,
      m && m.rawHash,
      normalizedHash(m && m.rawHash),
      normalizedHash(m && m.hash)
    ].filter(validMediaHash));
  }
  function validMediaHash(hash) {
    const h = String(hash || '').trim();
    if (!h || /^\d+$/.test(h)) return false;
    const raw = h.replace(/-/g, '+').replace(/_/g, '/');
    const bare = raw.replace(/=+$/, '');
    return /^[A-Za-z0-9+/]{22}$/.test(bare) && (raw.length === 22 || /^[A-Za-z0-9+/]{22}==$/.test(raw));
  }
  function firstMediaHash(items) {
    for (const item of items || []) {
      for (const hash of mediaHashes(item)) return hash;
    }
    return '';
  }
  function cleanMediaName(n) {
    return filenameFromUrl(n).trim();
  }
  function canonicalMediaName(n) {
    return cleanMediaName(n).toLowerCase();
  }
  function mediaExtension(n) {
    const m = canonicalMediaName(n).match(/\.([a-z0-9]{1,8})$/i);
    return m ? m[1] : '';
  }
  function mediaStem(n) {
    return canonicalMediaName(n).replace(/\.[^.]*$/, '');
  }
  function isTimMediaName(n) {
    return /^\d{6,}\.[a-z0-9]{1,8}$/i.test(canonicalMediaName(n));
  }
  function commonMediaStem(stem) {
    return /^(?:image|default|download|file|untitled|unknown|thumbnail|thumb|preview|photo|picture|pic|img|screenshot|screen shot|noimage|no image|missing|blank|avatar|media)(?:[\s._-]*\(?\d{1,4}\)?)?$/i.test(stem);
  }
  function distinctiveMediaName(n) {
    const name = canonicalMediaName(n);
    const ext = mediaExtension(name);
    if (!name || !ext) return false;
    if (isTimMediaName(name)) return true;
    const stem = mediaStem(name).trim();
    const compact = stem.replace(/[\s._-]+/g, '');
    if (!compact || commonMediaStem(stem) || commonMediaStem(compact)) return false;
    if (/^(?:\d{1,5}|[a-f0-9]{1,7})$/i.test(compact)) return false;
    return compact.length >= 6;
  }
  function distinctiveMediaNames(m) {
    const seen = new Set();
    const out = [];
    for (const n of mediaNames(m).map(cleanMediaName).filter(Boolean)) {
      const key = canonicalMediaName(n);
      if (!distinctiveMediaName(n) || seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }
  function mediaDimensions(m) {
    const w = Number(m && m.mediaW);
    const h = Number(m && m.mediaH);
    if (w > 0 && h > 0) return `${w}x${h}`;
    const text = String((m && m.meta) || '');
    const d = text.match(/(?:^|[^\d])(\d{1,5})\s*x\s*(\d{1,5})(?:[^\d]|$)/i);
    return d ? `${Number(d[1])}x${Number(d[2])}` : '';
  }
  function mediaByteSize(m) {
    const exact = Number(m && m.mediaSize);
    if (exact > 0) return exact;
    const text = String((m && m.meta) || '');
    const s = text.match(/([\d.]+)\s*(bytes?|b|kib|kb|mib|mb|gib|gb)\b/i);
    if (!s) return 0;
    const n = Number(s[1]);
    if (!(n > 0)) return 0;
    const unit = s[2].toLowerCase();
    const mult = unit.startsWith('g') ? 1024 * 1024 * 1024 :
      unit.startsWith('m') ? 1024 * 1024 :
      unit.startsWith('k') ? 1024 : 1;
    return Math.round(n * mult);
  }
  function mediaSizesAgree(a, b) {
    const diff = Math.abs(a - b);
    return diff <= Math.max(2048, Math.round(Math.max(a, b) * 0.02));
  }
  function mediaMetadataAgrees(a, b) {
    const ad = mediaDimensions(a), bd = mediaDimensions(b);
    const as = mediaByteSize(a), bs = mediaByteSize(b);
    let checks = 0;
    if (ad && bd) {
      if (ad !== bd) return false;
      checks++;
    }
    if (as && bs) {
      if (!mediaSizesAgree(as, bs)) return false;
      checks++;
    }
    return checks > 0;
  }
  function mediaNameMatches(seed, candidate) {
    const candidateNames = new Set(mediaNames(candidate).map(canonicalMediaName).filter(Boolean));
    if (!candidateNames.size) return false;
    for (const seedName of mediaNames(seed)) {
      const name = canonicalMediaName(seedName);
      if (!name || !candidateNames.has(name)) continue;
      if (distinctiveMediaName(name)) return true;
      if (mediaMetadataAgrees(seed, candidate)) return true;
    }
    return false;
  }
  function mediaName(m) {
    return (m && (m.fname || m.mediaFilenameProcessed || m.mediaFilename ||
      filenameFromUrl(m.full) || filenameFromUrl(m.mediaLink) ||
      filenameFromUrl(m.remoteMediaLink) || filenameFromUrl(m.thumb))) || '';
  }
  function mediaNames(m) {
    return uniq([
      m && m.fname,
      m && m.mediaFilename,
      m && m.mediaFilenameProcessed,
      m && m.archiveMedia,
      m && m.mediaOrig,
      m && m.previewOrig,
      m && m.previewOp,
      m && m.previewReply,
      m && filenameFromUrl(m.full),
      m && filenameFromUrl(m.mediaLink),
      m && filenameFromUrl(m.remoteMediaLink),
      m && filenameFromUrl(m.thumb),
      m && filenameFromUrl(m.thumbLink)
    ].filter(Boolean));
  }
  function searchPosts(data) {
    if (!data || data.error) return [];
    if (Array.isArray(data.posts)) return data.posts;
    const out = [];
    for (const v of Object.values(data)) {
      if (v && Array.isArray(v.posts)) out.push(...v.posts);
      else if (v && v.media) out.push(v);
    }
    return out;
  }
  function matchingSearchMedia(data, base, seeds, board) {
    const hashes = new Set(seeds.flatMap(mediaHashes).map(normalizedHash).filter(Boolean));
    const out = [];
    for (const post of searchPosts(data)) {
      const m = mediaFromApi(post.media, base, board || (post.board && post.board.shortname) || '');
      if (!m || (!m.thumb && !m.full)) continue;
      const hashMatch = hashes.size && mediaHashes(m).some((h) => hashes.has(normalizedHash(h)));
      const nameMatch = seeds.some((seed) => mediaNameMatches(seed, m));
      if (hashMatch || nameMatch) out.push(m);
    }
    return out;
  }

  const _searchMediaCache = new Map();
  async function searchArchiveMedia(board, seeds) {
    // Query both the url-safe hash and the raw base64 md5: FoolFuuka matches the
    // exact stored hash, and which form an archive accepts varies, so we try both.
    const hashes = uniq(seeds.flatMap(mediaHashes).filter(Boolean));
    const names = uniq(seeds.flatMap(distinctiveMediaNames));
    if (!hashes.length && !names.length) return [];
    const key = `${board}:${hashes.slice(0, 2).join(',')}:${names.slice(0, 2).join(',')}`;
    if (_searchMediaCache.has(key)) return _searchMediaCache.get(key);
    const p = (async () => {
      const queries = [];
      for (const h of hashes.slice(0, 6)) queries.push(['image', h]);
      for (const n of names.slice(0, 8)) queries.push(['filename', n]);
      const found = await Promise.all(archiveAPIsFor(board).flatMap((base) => queries.map(async ([field, value]) => {
        const url = `${base}/_/api/chan/search/?board=${board}&${field}=${encodeURIComponent(value)}`;
        let data;
        try { data = await gmJSON(url, 6000); }
        catch (e) { mediaDebug('warn', 'search API failed', { board, base, field, value, url, error: String(e && e.message || e) }); return []; }
        return matchingSearchMedia(data, base, seeds, board);
      })));
      const media = uniq(found.flat().filter((m) => m && (m.thumb || m.full)).map(JSON.stringify)).map(JSON.parse);
      mediaDebug(media.length ? 'debug' : 'warn', 'search API media results', { board, queries, count: media.length, media });
      if (!media.length) _searchMediaCache.delete(key);
      return media;
    })();
    _searchMediaCache.set(key, p);
    return p;
  }

  function addMediaUrlCandidates(out, url) {
    for (const u of imageCandidates(url)) out.push(u);
  }

  function mediaBoard(m) {
    return (m && m.board) || engine.board;
  }
  function mediaFullFiles(m) {
    if (mlpArchiveOrgFirstRequired(mediaBoard(m)) && !firstMediaHash([m])) return [];
    return uniq([
      m && m.archiveMedia,
      m && filenameFromUrl(m.full),
      m && filenameFromUrl(m.mediaLink),
      m && filenameFromUrl(m.remoteMediaLink)
    ].filter(Boolean));
  }
  function mediaThumbFiles(m) {
    const fullThumbs = mediaFullFiles(m).map(thumbNameFromImage).filter(Boolean);
    return uniq([
      m && m.previewReply,
      m && m.previewOp,
      m && m.previewOrig,
      m && filenameFromUrl(m.thumb),
      m && filenameFromUrl(m.thumbLink),
      ...fullThumbs
    ].filter(Boolean));
  }
  // ── archive.org re-hosted /mlp/ images (heinessen, 2012-05 → 2014-11) ────
  // 635k full-size golden-era images re-hosted by month. Some early month
  // items expose loose files as well as the month zip; later populated months
  // are stored as one zip per month. archive.org serves them at:
  //   https://archive.org/download/4chan-mlp-archive-YYYY-MM/<file>          (loose months)
  //   https://archive.org/download/4chan-mlp-archive-YYYY-MM/YYYY-MM.zip/<file>
  // The companion md5-index.json maps FoolFuuka media_hash values to exact
  // archive paths. Use that for zip members; guessing missing zip members makes
  // archive.org's view_archive.php return noisy server-side unzip 503s.
  const IA_MLP_FIRST = Date.UTC(2012, 4, 1) / 1000;   // coverage start, 2012-05-01
  const IA_MLP_END = Date.UTC(2014, 11, 1) / 1000;    // coverage end (excl), 2014-12-01
  const IA_MLP_DIRECT_MONTHS = new Set(['2012-05', '2012-06']);
  function archiveOrgIndexHashKeys(hash) {
    const h = String(hash || '').trim();
    if (!validMediaHash(h)) return [];
    const raw = h.replace(/-/g, '+').replace(/_/g, '/');
    const bare = raw.replace(/=+$/, '');
    return uniq([bare, `${bare}==`]);
  }
  function archiveOrgIndexPathCandidates(path) {
    const m = String(path || '').match(/^(\d{4}-\d{2})\/([^/?#]+)$/);
    if (!m) return [];
    const ym = m[1], file = m[2];
    const directUrl = `https://archive.org/download/4chan-mlp-archive-${ym}/${file}`;
    const zipUrl = `https://archive.org/download/4chan-mlp-archive-${ym}/${ym}.zip/${file}`;
    return IA_MLP_DIRECT_MONTHS.has(ym) ? [directUrl, zipUrl] : [zipUrl];
  }
  async function archiveOrgIndexedMedia(board, media) {
    if (!mlpArchiveOrgFirstRequired(board) || !media || !media.length) return [];
    const hashKeys = uniq(media.flatMap(mediaHashes).flatMap(archiveOrgIndexHashKeys));
    if (!hashKeys.length) return [];
    const index = await loadArchiveOrgMlpIndex();
    if (!index) return [];
    const seenPaths = new Set();
    const out = [];
    for (const hash of hashKeys) {
      const path = index[hash];
      if (!path || seenPaths.has(path)) continue;
      const urls = archiveOrgIndexPathCandidates(path);
      if (!urls.length) continue;
      seenPaths.add(path);
      const file = filenameFromUrl(path);
      out.push({
        full: urls[0],
        fname: file,
        board,
        hash: normalizedHash(hash),
        rawHash: hash,
        sourceBase: 'archive.org-index',
        archiveOrgUrls: urls,
        archiveIndexPath: path
      });
      mediaDebug('debug', 'archive.org md5 index hit', { board, hash, path, urls });
    }
    if (!out.length) {
      mediaDebug('debug', 'archive.org md5 index miss', { board, hashCount: hashKeys.length, hashes: hashKeys.slice(0, 6) });
    }
    return out;
  }
  function archiveOrgDownloadCandidates(board, file) {
    if (!mlpArchiveOrgFirstRequired(board)) return [];
    const m = String(file || '').match(/^(\d{10,13})\.[a-z0-9]+$/i);
    if (!m) {
      mediaDebug('debug', 'archive.org candidate skipped', { board, file, reason: 'filename is not a 4chan timestamp media name' });
      return [];
    }
    const ts = Number(m[1].slice(0, 10));
    if (!(ts >= IA_MLP_FIRST && ts < IA_MLP_END)) {
      mediaDebug('debug', 'archive.org candidate skipped', {
        board, file, ts,
        reason: 'timestamp outside archive.org mlp rehost coverage',
        coverageStart: IA_MLP_FIRST,
        coverageEndExclusive: IA_MLP_END
      });
      return [];
    }
    const d = new Date(ts * 1000);
    const ym = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    const urls = IA_MLP_DIRECT_MONTHS.has(ym)
      ? [`https://archive.org/download/4chan-mlp-archive-${ym}/${file}`]
      : [];
    if (!urls.length) {
      mediaDebug('debug', 'archive.org candidate skipped', {
        board, file, ts, ym,
        reason: 'zip member guesses require md5 index hit'
      });
      return [];
    }
    mediaDebug('debug', 'archive.org candidate added', {
      board, file, ts, ym,
      layout: 'direct guess',
      urls
    });
    return urls;
  }

  const MEDIA_URL_CAP = 24;
  function mediaUrlCandidates(m, kind) {
    if (!m) return [];
    const board = mediaBoard(m);
    const archiveOrgFirst = [], fast = [], slow = [];
    if (Array.isArray(m.archiveOrgUrls)) {
      for (const u of m.archiveOrgUrls) archiveOrgFirst.push(u);
    }
    if (kind === 'full') {
      for (const file of mediaFullFiles(m)) {
        for (const u of archiveOrgDownloadCandidates(board, file)) archiveOrgFirst.push(u);
      }
      if (mlpArchiveOrgFirstRequired(board)) {
        const candidates = uniq(archiveOrgFirst.filter(archiveOrgMlpRehostUrl)).slice(0, MEDIA_URL_CAP);
        mediaDebug(candidates.length ? 'debug' : 'warn', 'media URL candidates archive.org-only', {
          board,
          kind,
          count: candidates.length,
          archiveOrgOnly: true,
          names: mediaNames(m),
          candidates
        });
        return candidates;
      }
      for (const url of [m.full, m.mediaLink, m.remoteMediaLink]) addMediaUrlCandidates(fast, url);
      for (const file of mediaFullFiles(m)) {
        for (const u of mediaFilePathCandidates(board, 'image', file)) fast.push(u);
        for (const u of originalFourcdnCandidates(board, file)) fast.push(u);
        for (const u of extraArchiveCandidates(board, 'image', file)) slow.push(u);
        for (const u of waybackCandidates(board, file)) slow.push(u);
      }
      const candidates = uniq([...archiveOrgFirst, ...fast, ...slow]).slice(0, MEDIA_URL_CAP);
      if (board === 'mlp' || candidates.some((u) => /archive\.org/i.test(u))) {
        mediaDebug('debug', 'media URL candidates', {
          board,
          kind,
          count: candidates.length,
          archiveOrgFirst,
          archiveOrg: candidates.filter((u) => /archive\.org/i.test(u)),
          names: mediaNames(m),
          candidates
        });
      }
      return candidates;
    }

    for (const file of mediaFullFiles(m)) {
      for (const u of archiveOrgDownloadCandidates(board, file)) archiveOrgFirst.push(u);
    }
    if (mlpArchiveOrgFirstRequired(board)) {
      const candidates = uniq(archiveOrgFirst.filter(archiveOrgMlpRehostUrl)).slice(0, MEDIA_URL_CAP);
      mediaDebug(candidates.length ? 'debug' : 'warn', 'media URL candidates archive.org-only', {
        board,
        kind,
        count: candidates.length,
        archiveOrgOnly: true,
        names: mediaNames(m),
        candidates
      });
      return candidates;
    }
    for (const url of [m.thumb, m.thumbLink]) addMediaUrlCandidates(fast, url);
    for (const url of [m.full, m.mediaLink, m.remoteMediaLink]) {
      for (const u of thumbCandidatesFromFull(url)) fast.push(u);
    }
    for (const file of mediaThumbFiles(m)) {
      for (const u of mediaFilePathCandidates(board, 'thumb', file)) fast.push(u);
      for (const u of extraArchiveCandidates(board, 'thumb', file)) slow.push(u);
      for (const u of waybackThumbCandidates(board, file)) slow.push(u);
    }
    const candidates = uniq([...archiveOrgFirst, ...fast, ...slow]).slice(0, MEDIA_URL_CAP);
    if (board === 'mlp' || candidates.some((u) => /archive\.org/i.test(u))) {
      mediaDebug('debug', 'media URL candidates', {
        board,
        kind,
        count: candidates.length,
        archiveOrgFirst,
        archiveOrg: candidates.filter((u) => /archive\.org/i.test(u)),
        names: mediaNames(m),
        candidates
      });
    }
    return candidates;
  }

  function fullUrls(media) {
    const out = [];
    for (const m of media) for (const u of mediaUrlCandidates(m, 'full')) out.push(u);
    return uniq(out);
  }
  function thumbUrls(media) {
    const out = [];
    for (const m of media) for (const u of mediaUrlCandidates(m, 'thumb')) out.push(u);
    return uniq(out);
  }
  // A blob that failed verification must be evicted everywhere, not just
  // revoked: _blobCache would otherwise re-serve the dead object URL and the
  // persistent cache would re-serve the wrong bytes across sessions.
  function discardRejectedBlob(found) {
    URL.revokeObjectURL(found.blob);
    _blobCache.delete(found.url);
    if (mediaCacheAvailable()) {
      openMediaCache()
        .then((cache) => cache.delete(mediaCacheRequestUrl(found.url)))
        .catch(() => { /* best effort */ });
    }
  }
  async function firstVerifiedBlob(urls, expectedHash) {
    const unique = uniq(urls);
    mediaDebug('debug', 'verified candidate list', {
      count: unique.length,
      expectedHash,
      archiveOrg: unique.filter((u) => /archive\.org/i.test(u)),
      urls: unique
    });
    const batchSize = mediaCandidateBatchSize();
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      mediaDebug('debug', 'verified candidate batch', { start: i, size: batch.length, expectedHash, urls: batch });
      const found = await firstBlobBatch(batch);
      if (!found) {
        mediaDebug('debug', 'verified candidate batch miss', { start: i, size: batch.length, expectedHash });
        continue;
      }
      if (!expectedHash || await verifyBlobHash(found.blob, expectedHash)) {
        mediaDebug('debug', 'verified candidate selected', { url: found.url, expectedHash });
        return found;
      }
      mediaDebug('warn', 'hash mismatch, skipping candidate', { url: found.url, expectedHash });
      discardRejectedBlob(found);
    }
    mediaDebug('warn', 'verified candidate list failed', { count: unique.length, expectedHash });
    return null;
  }
  async function firstFull(media, expectedHash) {
    const r = expectedHash
      ? await firstVerifiedBlob(fullUrls(media), expectedHash)
      : await firstBlob(fullUrls(media));
    return r ? { ...r, thumbFallback: false } : null;
  }
  async function firstThumb(media) {
    const r = await firstBlob(thumbUrls(media));
    return r ? { ...r, thumbFallback: true } : null;
  }
  function mediaUrlsMatching(urls, wantArchiveOrg) {
    return uniq(urls).filter((u) => archiveOrgMedia(u) === wantArchiveOrg);
  }
  async function firstFullMatching(media, expectedHash, wantArchiveOrg) {
    const urls = mediaUrlsMatching(fullUrls(media), wantArchiveOrg);
    const r = expectedHash ? await firstVerifiedBlob(urls, expectedHash) : await firstBlob(urls);
    return r ? { ...r, thumbFallback: false } : null;
  }
  async function firstThumbMatching(media, wantArchiveOrg) {
    const r = await firstBlob(mediaUrlsMatching(thumbUrls(media), wantArchiveOrg));
    return r ? { ...r, thumbFallback: true } : null;
  }
  async function firstArchiveOrgFull(board, media, expectedHash) {
    const indexed = await archiveOrgIndexedMedia(board, media);
    let r = await firstFull(indexed, expectedHash);
    if (r) return r;
    const urls = mlpArchiveOrgFirstRequired(board)
      ? uniq(fullUrls(media).filter(archiveOrgMlpRehostUrl))
      : mediaUrlsMatching(fullUrls(media), true);
    const found = expectedHash ? await firstVerifiedBlob(urls, expectedHash) : await firstBlob(urls);
    return found ? { ...found, thumbFallback: false } : null;
  }
  const FOURCHAN_404_IMAGES = [
    'Angelguy.png',
    'Anonymous-2.jpg',
    'Anonymous-2.png',
    'Anonymous-3.jpg',
    'Anonymous-3.png',
    'Anonymous-4.png',
    'Anonymous-5.png',
    'Anonymous-6.png',
    'Anonymous-7.png',
    'Anonymous-8.png',
    'Anonymous.gif',
    'Anonymous.jpg',
    'Anonymous.png',
    'DanKim.gif',
    'Kobayen.png',
    'Ragathol.png',
    'anonymouse.png'
  ];
  const MLP_MISSING_IMAGE_PLACEHOLDERS = [
    'https://derpicdn.net/img/view/2025/4/21/3591172.png',
    'https://derpicdn.net/img/view/2014/7/22/681028.png',
    'https://derpicdn.net/img/2016/7/10/1197996/large.png',
    'https://derpicdn.net/img/2025/5/4/3599187/full.png',
    'https://derpicdn.net/img/view/2022/5/22/2870238.png',
    'https://derpicdn.net/img/view/2019/3/1/1974289.jpg',
    'https://derpicdn.net/img/view/2019/11/29/2208464.jpg'
  ];
  function stringHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function fourChan404Url(seed) {
    const files = FOURCHAN_404_IMAGES;
    const file = files[stringHash(seed || String(Math.random())) % files.length];
    return `https://s.4cdn.org/image/error/404/404-${file}`;
  }
  function missingImagePlaceholderUrl(board, seed) {
    if (board === 'mlp') {
      const urls = MLP_MISSING_IMAGE_PLACEHOLDERS;
      return urls[stringHash(seed || String(Math.random())) % urls.length];
    }
    return fourChan404Url(seed);
  }
  async function missingImagePlaceholderBlob(board, seed) {
    const url = missingImagePlaceholderUrl(board, seed);
    const blob = await gmBlobURL(url);
    return blob ? { blob, url, placeholder: true } : null;
  }
  // Convert base64 MD5 (from archive media_hash) to hex for booru lookups.
  function md5Base64ToHex(b64) {
    if (!b64) return '';
    try {
      const raw = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
      let hex = '';
      for (let i = 0; i < raw.length; i++) hex += raw.charCodeAt(i).toString(16).padStart(2, '0');
      return hex;
    } catch (e) { return ''; }
  }
  // Last-resort: search booru sites by MD5 hash. Many 4chan images end up on
  // boorus with the original hash intact.
  const BOORU_BOARDS = new Set(['a', 'c', 'cm', 'co', 'e', 'h', 'w', 'wg', 'wsr', 'ic', 'y', 'd', 'gif']);
  async function booruMd5Search(hash) {
    const hex = md5Base64ToHex(hash);
    if (!hex || hex.length !== 32) return null;
    const endpoints = [
      { url: `https://yande.re/post.json?tags=md5:${hex}&limit=1`, parse: (d) => d[0] && d[0].file_url },
      { url: `https://konachan.com/post.json?tags=md5:${hex}&limit=1`, parse: (d) => d[0] && d[0].file_url },
      { url: `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&tags=md5:${hex}&limit=1`, parse: (d) => {
        const p = (d.post || d)[0]; if (!p) return null;
        const dir = p.directory || ''; const img = p.image || '';
        return img ? `https://safebooru.org/images/${dir}/${img}` : null;
      }},
    ];
    for (const ep of endpoints) {
      try {
        const data = await gmJSON(ep.url, 6000);
        const fileUrl = ep.parse(Array.isArray(data) ? data : (data && data.post ? data : []));
        if (fileUrl) {
          const blob = await gmBlobURL(fileUrl);
          if (blob) return { blob, url: fileUrl, thumbFallback: false };
        }
      } catch (e) { /* booru unavailable, skip */ }
    }
    return null;
  }
  async function resolveMlpArchiveOrgFirstMedia(p, kind, ctx, local, expectedHash, apiP) {
    const api = await apiP;
    const apiHash = expectedHash || firstMediaHash(api);
    const primarySeeds = [...local, ...api];
    const primaryHash = apiHash || expectedHash;
    mediaDebug(api.length ? 'debug' : 'warn', `resolve ${kind} post API candidates`, { ...ctx, count: api.length, archiveOrgFirst: true });

    let r = await firstArchiveOrgFull(engine.board, primarySeeds, primaryHash);
    if (r) {
      mediaDebug('debug', `resolve selected ${kind} archive.org first`, { ...ctx, url: r.url });
      return { ...r, thumbFallback: false };
    }

    const searched = primaryHash ? [] : await searchArchiveMedia(engine.board, primarySeeds);
    if (!primaryHash || searched.length) {
      mediaDebug(searched.length ? 'debug' : 'warn', `resolve ${kind} search candidates`, { ...ctx, count: searched.length, archiveOrgFirst: true });
    }
    const searchedSeeds = [...primarySeeds, ...searched];
    if (searched.length) {
      r = await firstArchiveOrgFull(engine.board, searchedSeeds, primaryHash);
      if (r) {
        mediaDebug('debug', `resolve selected ${kind} archive.org first search`, { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
    }

    mediaDebug('warn', 'resolve miss, archive.org-only mode', {
      ...ctx,
      hash: primaryHash,
      localCount: local.length,
      apiCount: api.length,
      searchCount: searched.length
    });
    return null;
  }
  async function resolvePostMediaBlob(p, kind) {
    if (!p || !p.num) return null;
    const ctx = { board: engine.board, num: p.num, kind };
    const local = p.media ? [p.media] : [];
    const expectedHash = firstMediaHash(local);
    mediaDebug('debug', 'resolve start', {
      ...ctx,
      expectedHash,
      local: local.map((m) => ({ full: m && m.full, thumb: m && m.thumb, fname: m && m.fname, hash: m && m.hash }))
    });
    const apiP = postArchiveMedia(engine.board, p.num);
    if (mlpArchiveOrgFirstRequired(engine.board)) {
      return resolveMlpArchiveOrgFirstMedia(p, kind, ctx, local, expectedHash, apiP);
    }

    if (kind === 'thumb') {
      const indexedLocal = await archiveOrgIndexedMedia(engine.board, local);
      let r = await firstFull(indexedLocal, expectedHash);
      if (r) {
        mediaDebug('debug', 'resolve selected thumb archive.org index local', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      r = await firstBlob(thumbUrls(local));
      if (r) {
        mediaDebug('debug', 'resolve selected thumb local', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      const api = await apiP;
      const apiHash = expectedHash || firstMediaHash(api);
      mediaDebug(api.length ? 'debug' : 'warn', 'resolve thumb post API candidates', { ...ctx, count: api.length });
      const indexedApi = await archiveOrgIndexedMedia(engine.board, [...local, ...api]);
      r = await firstFull(indexedApi, apiHash);
      if (r) {
        mediaDebug('debug', 'resolve selected thumb archive.org index post API', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      r = await firstBlob(thumbUrls(api));
      if (r) {
        mediaDebug('debug', 'resolve selected thumb post API', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      const searched = await searchArchiveMedia(engine.board, [...local, ...api]);
      mediaDebug(searched.length ? 'debug' : 'warn', 'resolve thumb search candidates', { ...ctx, count: searched.length });
      const indexedSearched = await archiveOrgIndexedMedia(engine.board, [...local, ...api, ...searched]);
      r = await firstFull(indexedSearched, apiHash || expectedHash);
      if (r) {
        mediaDebug('debug', 'resolve selected thumb archive.org index search', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      r = await firstBlob(thumbUrls(searched));
      if (r) {
        mediaDebug('debug', 'resolve selected thumb search', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      const fullHash = apiHash || expectedHash;
      r = fullHash
        ? await firstVerifiedBlob(fullUrls([...local, ...api, ...searched]), fullHash)
        : await firstBlob(fullUrls([...local, ...api, ...searched]));
      if (r) {
        mediaDebug('debug', 'resolve selected thumb full-fallback', { ...ctx, url: r.url });
        return { ...r, thumbFallback: false };
      }
      mediaDebug('warn', 'resolve miss', ctx);
      return null;
    }

    const fullHash = expectedHash;
    const indexedLocal = await archiveOrgIndexedMedia(engine.board, local);
    let r = await firstFull(indexedLocal, fullHash);
    if (r) {
      mediaDebug('debug', 'resolve selected full archive.org index local', { ...ctx, url: r.url });
      return r;
    }
    r = await firstFull(local, fullHash);
    if (r) {
      mediaDebug('debug', 'resolve selected full local', { ...ctx, url: r.url });
      return r;
    }
    const api = await apiP;
    const apiHash = fullHash || firstMediaHash(api);
    mediaDebug(api.length ? 'debug' : 'warn', 'resolve full post API candidates', { ...ctx, count: api.length });
    const indexedApi = await archiveOrgIndexedMedia(engine.board, [...local, ...api]);
    r = await firstFull(indexedApi, apiHash);
    if (r) {
      mediaDebug('debug', 'resolve selected full archive.org index post API', { ...ctx, url: r.url });
      return r;
    }
    r = await firstFull(api, apiHash);
    if (r) {
      mediaDebug('debug', 'resolve selected full post API', { ...ctx, url: r.url });
      return r;
    }
    const searched = await searchArchiveMedia(engine.board, [...local, ...api]);
    mediaDebug(searched.length ? 'debug' : 'warn', 'resolve full search candidates', { ...ctx, count: searched.length });
    const indexedSearched = await archiveOrgIndexedMedia(engine.board, [...local, ...api, ...searched]);
    r = await firstFull(indexedSearched, apiHash);
    if (r) {
      mediaDebug('debug', 'resolve selected full archive.org index search', { ...ctx, url: r.url });
      return r;
    }
    r = await firstFull(searched, apiHash);
    if (r) {
      mediaDebug('debug', 'resolve selected full search', { ...ctx, url: r.url });
      return r;
    }

    const all = [...local, ...api, ...searched];
    r = await firstThumb(all);
    if (r) {
      mediaDebug('warn', 'resolve selected thumb fallback for full', { ...ctx, url: r.url });
      return r;
    }
    if (BOORU_BOARDS.has(engine.board) && (apiHash || expectedHash)) {
      r = await booruMd5Search(apiHash || expectedHash);
      if (r) {
        mediaDebug('debug', 'resolve selected booru md5 match', { ...ctx, url: r.url });
        return r;
      }
    }
    mediaDebug('warn', 'resolve miss', ctx);
    return null;
  }

  const _postBlobCache = new Map();
  const _postBlobResultCache = new Map();
  function postMediaCacheKey(p, kind) {
    return p && p.num ? `${engine.board}:${p.num}:${kind}` : '';
  }
  function cachedPostMediaResult(p, kind) {
    const key = postMediaCacheKey(p, kind);
    return key ? _postBlobResultCache.get(key) || null : null;
  }
  async function postMediaBlob(p, kind) {
    if (!p || !p.num) return null;
    const key = postMediaCacheKey(p, kind);
    if (p.media && p.media.localDataURL) {
      const r = { blob: p.media.localDataURL, url: p.media.localDataURL, local: true };
      if (key) _postBlobResultCache.set(key, r);
      return r;
    }
    if (_postBlobResultCache.has(key)) return _postBlobResultCache.get(key);
    if (_postBlobCache.has(key)) {
      mediaDebug('debug', 'blob cache hit', { board: engine.board, num: p.num, kind, key });
      return _postBlobCache.get(key);
    }
    const resolvedKey = mediaResolveCacheKey(engine.board, p.num, kind);
    const cachedResolved = cacheGet(resolvedKey);
    if (cachedResolved && cachedResolved.url) {
      mediaDebug('debug', 'cached resolved URL check', {
        board: engine.board,
        num: p.num,
        kind,
        resolvedKey,
        url: cachedResolved.url,
        thumbFallback: !!cachedResolved.thumbFallback
      });
      const cachedPromise = gmBlobURL(cachedResolved.url).then((blob) => {
        if (blob) {
          const r = {
            blob,
            url: cachedResolved.url,
            thumbFallback: !!cachedResolved.thumbFallback
          };
          mediaDebug('debug', 'cached resolved URL ok', {
            board: engine.board,
            num: p.num,
            kind,
            resolvedKey,
            url: cachedResolved.url
          });
          _postBlobResultCache.set(key, r);
          return r;
        }
        mediaDebug('warn', 'cached resolved URL failed, invalidating', {
          board: engine.board,
          num: p.num,
          kind,
          resolvedKey,
          url: cachedResolved.url
        });
        cacheDelete(resolvedKey);
        _postBlobCache.delete(key);
        _postBlobResultCache.delete(key);
        return postMediaBlob(p, kind);
      });
      _postBlobCache.set(key, cachedPromise);
      return cachedPromise;
    }
    if (cachedResolved && cachedResolved.miss && Date.now() - (cachedResolved.cachedAt || 0) < CONFIG.mediaMissCacheMs) {
      mediaDebug('debug', 'cached media miss', {
        board: engine.board,
        num: p.num,
        kind,
        resolvedKey,
        ageMs: Date.now() - (cachedResolved.cachedAt || 0)
      });
      return Promise.resolve(null);
    }
    if (cachedResolved && cachedResolved.miss) {
      mediaDebug('debug', 'expired cached media miss, retrying', {
        board: engine.board,
        num: p.num,
        kind,
        resolvedKey,
        ageMs: Date.now() - (cachedResolved.cachedAt || 0)
      });
      cacheDelete(resolvedKey);
    }
    const promise = resolvePostMediaBlob(p, kind).then((r) => {
      if (!r || (kind === 'full' && r.thumbFallback)) _postBlobCache.delete(key);
      if (r && !(kind === 'full' && r.thumbFallback)) _postBlobResultCache.set(key, r);
      else _postBlobResultCache.delete(key);
      if (r && r.url && !(kind === 'full' && r.thumbFallback)) {
        cacheSet(resolvedKey, {
          url: r.url,
          thumbFallback: !!r.thumbFallback,
          cachedAt: Date.now()
        });
      } else if (!r && !networkDisturbed()) {
        // Persist the miss only when the network was healthy — a null during
        // a rate-limit storm or host outage would blank the image for 24h.
        cacheSet(resolvedKey, { miss: true, cachedAt: Date.now() });
      }
      mediaDebug(r ? 'debug' : 'warn', r ? 'blob resolve ok' : 'blob resolve failed', {
        board: engine.board,
        num: p.num,
        kind,
        key,
        result: r && { url: r.url, thumbFallback: !!r.thumbFallback }
      });
      return r;
    });
    _postBlobCache.set(key, promise);
    return promise;
  }

  // ── Cache (GM storage, JSON only) ──────────────────────────────────────────
  function cacheDebug(level, msg, data = {}) {
    if (!CONFIG.cacheDebug) return;
    const fn = level === 'warn' ? console.warn : console.debug;
    try { fn.call(console, `[oldchan cache] ${msg}`, data); } catch (e) { /* console unavailable */ }
  }
  const cacheGet = (k) => {
    try { return JSON.parse(GM_getValue(k, 'null')); }
    catch (e) { cacheDebug('warn', 'cache read failed', { key: k, error: String(e && e.message || e) }); return null; }
  };
  function cacheKeys() {
    try { return typeof GM_listValues === 'function' ? GM_listValues() : []; }
    catch (e) { cacheDebug('warn', 'cache key listing failed', { error: String(e && e.message || e) }); return []; }
  }
  function cacheDelete(k) {
    try {
      GM_deleteValue(k);
      _storageBytes.delete(k);
      return true;
    } catch (e) { cacheDebug('warn', 'cache delete failed', { key: k, error: String(e && e.message || e) }); return false; }
  }
  const CACHE_MAX_BYTES = 8 * 1024 * 1024;
  const CACHE_HARD_CEILING = 48 * 1024 * 1024; // absolute max — 64MiB messaging limit is fatal
  const CACHE_PROTECTED_KEYS = new Set(['settings', 'clockAnchor', 'postIdentity:v1']);
  const _storageBytes = new Map();
  let _storageTotalBytes = 0;
  let _storageScanDone = false;
  function initStorageEstimate() {
    try {
      const keys = cacheKeys();
      let total = 0;
      for (const k of keys) {
        let sz = 0;
        try { sz = String(GM_getValue(k, '')).length; } catch (e) { sz = 500; }
        _storageBytes.set(k, sz);
        total += sz;
      }
      _storageTotalBytes = total;
      _storageScanDone = true;
    } catch (e) {
      _storageTotalBytes = CACHE_HARD_CEILING;
      _storageScanDone = false;
    }
  }
  function pruneStorage(exceptKey, targetBytes = CACHE_MAX_BYTES) {
    const keys = cacheKeys().filter((k) => !CACHE_PROTECTED_KEYS.has(k) && k !== exceptKey);
    if (!keys.length) return 0;
    let canRead = true;
    const scored = keys.map((k) => {
      let cachedAt = 0, size = _storageBytes.get(k) || 0;
      if (!size) {
        try {
          const raw = String(GM_getValue(k, ''));
          size = raw.length;
          _storageBytes.set(k, size);
          const m = raw.match(/"cachedAt"\s*:\s*(\d+)/);
          cachedAt = m ? Number(m[1]) : 0;
        } catch (e) { canRead = false; size = 500; }
      } else {
        try {
          const raw = String(GM_getValue(k, ''));
          const m = raw.match(/"cachedAt"\s*:\s*(\d+)/);
          cachedAt = m ? Number(m[1]) : 0;
        } catch (e) { canRead = false; }
      }
      return { key: k, cachedAt, size };
    }).sort((a, b) => a.cachedAt - b.cachedAt);
    if (!canRead) {
      let deleted = 0;
      for (const item of scored) { if (cacheDelete(item.key)) deleted++; }
      _storageTotalBytes = 0;
      return deleted;
    }
    let total = scored.reduce((s, e) => s + e.size, 0);
    _storageTotalBytes = total;
    let deleted = 0;
    for (const item of scored) {
      if (total <= targetBytes) break;
      if (cacheDelete(item.key)) { total -= item.size; deleted++; }
    }
    _storageTotalBytes = total;
    return deleted;
  }
  function cacheSet(k, v) {
    const text = JSON.stringify(v);
    const oldSize = _storageBytes.get(k) || 0;
    const newTotal = _storageTotalBytes - oldSize + text.length;
    if (newTotal > CACHE_HARD_CEILING) return false;
    if (newTotal > CACHE_MAX_BYTES) {
      pruneStorage(k, CACHE_MAX_BYTES * 0.6);
    }
    try {
      GM_setValue(k, text);
      _storageBytes.set(k, text.length);
      _storageTotalBytes = _storageTotalBytes - oldSize + text.length;
      return true;
    } catch (e) {
      cacheDebug('warn', 'cache write failed', { key: k, bytes: text.length, error: String(e && e.message || e) });
      return false;
    }
  }
  const indexCacheKey = (board, date) => `idx:v8:${board}:${date}`;
  const catalogCacheKey = (board, date) =>
    `catalog:v9:${board}:${date}:active${CONFIG.catalogActivityThreadTarget}:d${CONFIG.catalogActivityMaxDays}`;
  function cachedCatalogOps(board, date) {
    const cached = cacheGet(catalogCacheKey(board, date));
    const ops = Array.isArray(cached) ? cached : (cached && Array.isArray(cached.ops) ? cached.ops : null);
    return ops && ops.length ? mergeLocalCatalogOps(ops, board, date) : [];
  }
  const indexPageCacheKey = (board, date, base, page) =>
    `idxp:v1:${board}:${date}:${base.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_')}:${page}`;
  const activityPageCacheKey = (board, date, base, page) =>
    `actp:v1:${board}:${date}:${base.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_')}:${page}`;
  const threadCacheKey = (board, num) => `thr:v5:${board}:${num}`;
  const threadSummaryCacheKey = (board, num) => `thrs:v1:${board}:${num}`;
  const mediaResolveCacheKey = (board, num, kind) => `media:v11:${board}:${num}:${kind}`;
  const localPostCacheKey = (board) => `localposts:v1:${board}`;
  const postIdentityCacheKey = () => 'postIdentity:v1';

  const LOCAL_POST_NUM_BASE = 9000000000000;
  function emptyLocalPostStore() {
    return { nextNum: LOCAL_POST_NUM_BASE, posts: [] };
  }
  function validLocalPost(p) {
    return !!(p && p.num && p.threadNum && p.board && typeof p.ts === 'number');
  }
  function localPostStore(board = engine.board) {
    const store = cacheGet(localPostCacheKey(board)) || emptyLocalPostStore();
    const posts = Array.isArray(store.posts) ? store.posts.filter(validLocalPost) : [];
    return {
      nextNum: Math.max(LOCAL_POST_NUM_BASE, Number(store.nextNum) || LOCAL_POST_NUM_BASE),
      posts
    };
  }
  function saveLocalPostStore(board, store) {
    return cacheSet(localPostCacheKey(board), {
      nextNum: Math.max(LOCAL_POST_NUM_BASE, Number(store.nextNum) || LOCAL_POST_NUM_BASE),
      posts: Array.isArray(store.posts) ? store.posts.filter(validLocalPost) : []
    });
  }
  function nextLocalPostNum(store) {
    const used = new Set((store.posts || []).map((p) => String(p.num)));
    let n = Math.max(LOCAL_POST_NUM_BASE, Number(store.nextNum) || LOCAL_POST_NUM_BASE);
    while (used.has(String(n))) n++;
    store.nextNum = n + 1;
    return String(n);
  }
  function localPostsForBoard(board = engine.board) {
    return localPostStore(board).posts.slice().sort((a, b) => a.ts - b.ts || Number(a.num) - Number(b.num));
  }
  function localPostsForThread(board, num) {
    const threadNum = String(num);
    return localPostsForBoard(board).filter((p) => String(p.threadNum) === threadNum);
  }
  function localOpsForDate(board, date) {
    return localPostsForBoard(board).filter((p) => p.op && p.date === date);
  }
  function mergeLocalOps(ops, board, date) {
    return sortedUniqueOps([...(ops || []), ...localOpsForDate(board, date)]);
  }
  function mergeLocalCatalogOps(ops, board, date) {
    const all = [...(ops || [])];
    const snapshotTs = replayEndTs(date);
    all.push(...localPostsForBoard(board).filter((p) => p.op && p.ts <= snapshotTs));
    return sortedUniqueOps(all);
  }
  function mergeThreadPosts(archivePosts, localPosts) {
    const byNum = new Map();
    for (const p of archivePosts || []) if (p && p.num) byNum.set(String(p.num), p);
    for (const p of localPosts || []) if (p && p.num) byNum.set(String(p.num), p);
    return Array.from(byNum.values()).sort((a, b) =>
      (b.op ? 1 : 0) - (a.op ? 1 : 0) || a.ts - b.ts || Number(a.num) - Number(b.num));
  }
  function mergeLocalThreadResult(board, num, result) {
    const locals = localPostsForThread(board, num);
    if (!locals.length) return result;
    const archivePosts = validThreadResult(result) ? result.posts : [];
    const posts = mergeThreadPosts(archivePosts, locals);
    if (!posts.length || !posts[0].op) return result;
    return {
      ...(result && typeof result === 'object' ? result : {}),
      posts,
      source: result && result.source ? `${result.source}+local` : 'local'
    };
  }
  function summaryWithLocalPosts(board, op, summary) {
    if (!op || !op.num) return summary;
    if (summary && summary.localApplied) return summary;
    const locals = localPostsForThread(board, op.num);
    if (!locals.length) return summary;
    const localOp = locals.find((p) => p.op);
    if (localOp) {
      const localSummary = threadSummaryFromPosts(mergeThreadPosts(summary ? [op] : [], locals));
      return localSummary ? { ...localSummary, localApplied: true } : summary;
    }
    const replies = locals.filter((p) => !p.op);
    if (!replies.length) return summary;
    const base = summary || {
      num: String(op.num),
      opTs: op.ts,
      bump: op.ts,
      sticky: !!op.sticky,
      deleted: !!op.deleted,
      expiredTs: op.expiredTs || 0,
      lastTs: op.ts,
      replyCount: 0,
      imageCount: postHasMedia(op) ? 1 : 0,
      omittedImages: 0,
      cachedAt: Date.now()
    };
    let bump = base.bump;
    for (const p of replies) if (!isSagePost(p)) bump = Math.max(bump, p.ts);
    return {
      ...base,
      bump,
      lastTs: Math.max(base.lastTs || op.ts, ...replies.map((p) => p.ts)),
      replyCount: (base.replyCount || 0) + replies.length,
      imageCount: (base.imageCount || 0) + replies.filter(postHasMedia).length,
      omittedImages: (base.omittedImages || 0) + replies.filter(postHasMedia).length,
      localApplied: true,
      cachedAt: Date.now()
    };
  }
  function loadPostIdentity() {
    const id = cacheGet(postIdentityCacheKey()) || {};
    return {
      name: typeof id.name === 'string' ? id.name : '',
      email: typeof id.email === 'string' ? id.email : '',
      password: typeof id.password === 'string' ? id.password : ''
    };
  }
  function savePostIdentity(identity) {
    cacheSet(postIdentityCacheKey(), {
      name: identity.name || '',
      email: identity.email || '',
      password: identity.password || ''
    });
  }

  // ── Archive API ────────────────────────────────────────────────────────────
  // Enumerate a board's OPs for a date by parsing the HTML path-search page.
  // NOTE: the JSON search API (/_/api/chan/search) has broken date filtering on
  // these archives — it returns posts from every era stamped with the query
  // date. The website's own path-style search filters correctly, so we parse
  // that HTML instead. Verified: <time datetime> here == JSON API `timestamp`.
  function parseSearchOps(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const arts = doc.querySelectorAll('article.post.post_is_op');
    const ops = [];
    arts.forEach((a) => {
      const num = /^\d+$/.test(a.id) ? a.id : null;
      if (!num) return;
      const timeEl = a.querySelector('time[datetime]');
      const ts = timeEl ? Math.floor(Date.parse(timeEl.getAttribute('datetime')) / 1000) : NaN;
      if (!ts || isNaN(ts)) return;
      const titleEl = a.querySelector('.post_title');
      const nameEl = a.querySelector('.post_author');
      const tripEl = a.querySelector('.post_tripcode');
      const textEl = a.querySelector('.text');
      const thumbImg = a.querySelector('img.post_image');
      const fnEl = a.querySelector('a.post_file_filename');
      const metaEl = a.querySelector('.post_file_metadata');
      const thumb = thumbImg ? thumbImg.getAttribute('src') : null;
      ops.push({
        num, ts,
        title: titleEl ? titleEl.textContent.trim() : '',
        name: nameEl ? nameEl.textContent.trim() : 'Anonymous',
        trip: tripEl ? tripEl.textContent.trim() : '',
        email: '',
        sticky: false,
        locked: false,
        deleted: false,
        expiredTs: 0,
        comment: textEl ? textEl.innerHTML : '',
        preformatted: true,   // .text is already FoolFuuka-formatted HTML
        fourchan_date: timeEl ? (timeEl.getAttribute('title') || '').replace('4chan Time: ', '') : '',
        media: (thumb || fnEl) ? {
          thumb,
          full: fnEl ? fnEl.getAttribute('href') : null,
          fname: fnEl ? fnEl.textContent.trim() : '',
          meta: metaEl ? metaEl.textContent.trim() : ''
        } : null
      });
    });
    return ops;
  }

  function sortedUniqueOps(ops) {
    const seen = new Set();
    const out = [];
    for (const op of ops || []) {
      if (!op || !op.num || seen.has(op.num)) continue;
      seen.add(op.num);
      out.push(op);
    }
    return out.sort((a, b) => a.ts - b.ts || Number(a.num) - Number(b.num));
  }
  function threadNumFromSearchArticle(a) {
    if (!a) return '';
    if (a.classList && a.classList.contains('post_is_op') && /^\d+$/.test(a.id || '')) return String(a.id);
    const direct = a.getAttribute && a.getAttribute('data-thread-num');
    if (direct && /^\d+$/.test(direct)) return direct;
    const stub = a.previousElementSibling && a.previousElementSibling.getAttribute &&
      a.previousElementSibling.getAttribute('data-thread-num');
    if (stub && /^\d+$/.test(stub)) return stub;
    const link = a.querySelector('a[href*="/thread/"]');
    const href = link && link.getAttribute('href');
    const m = href && href.match(/\/thread\/(\d+)/);
    return m ? m[1] : '';
  }
  function parseSearchActivity(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const arts = doc.querySelectorAll('article.post');
    const posts = [];
    arts.forEach((a) => {
      const num = /^\d+$/.test(a.id || '') ? String(a.id) : '';
      const threadNum = threadNumFromSearchArticle(a);
      if (!threadNum) return;
      const timeEl = a.querySelector('time[datetime]');
      const ts = timeEl ? Math.floor(Date.parse(timeEl.getAttribute('datetime')) / 1000) : NaN;
      if (!ts || isNaN(ts)) return;
      posts.push({ num, threadNum, ts });
    });
    return posts;
  }

  async function enumerateArchiveDay(board, date, base, opts = {}) {
    const end = nextDay(date);
    const ops = [];
    const seen = new Set();
    let fetched = false;
    let disabled = false;
    const maxPages = Math.max(1, CONFIG.catalogSearchMaxPages || 60);
    for (let page = 1; page <= maxPages; page++) {
      const url = `${base}/${board}/search/start/${date}/end/${end}/type/op/order/asc/page/${page}/`;
      const pageKey = indexPageCacheKey(board, date, base, page);
      const cachedPage = !opts.force && cacheGet(pageKey);
      let pageOps = null;
      let fromCache = false;
      if (cachedPage && Array.isArray(cachedPage.ops)) {
        pageOps = cachedPage.ops;
        fromCache = true;
        fetched = true;
      } else {
        let html;
        try { html = await gmText(url); }
        catch (e) { return { ops, ok: fetched, error: String(e && e.message || e), base }; }
        fetched = true;
        if (/Just a moment|Enable JavaScript and cookies|cdn-cgi\/challenge-platform/i.test(html)) {
          return { ops, ok: false, error: 'Cloudflare challenge', base };
        }
        if (/does not have search enabled/i.test(html)) {
          disabled = true;
          break;
        }
        pageOps = parseSearchOps(html);
        cacheSet(pageKey, { ops: pageOps, cachedAt: Date.now() });
      }
      if (!pageOps.length) break;
      let added = 0;
      for (const op of pageOps) {
        if (!op || !op.num || seen.has(op.num)) continue;
        seen.add(op.num);
        added++;
        ops.push(op);
      }
      if (added && opts.onProgress) opts.onProgress(sortedUniqueOps(ops), { board, date, base, page, fromCache });
      if (!added) break;
      if (!fromCache && CONFIG.catalogPageDelayMs) await sleep(CONFIG.catalogPageDelayMs); // be polite
    }
    return { ops: sortedUniqueOps(ops), ok: fetched && !disabled, disabled, base };
  }

  async function enumerateArchiveActivityDay(board, date, base, opts = {}) {
    const end = nextDay(date);
    const posts = [];
    const seenPosts = new Set();
    const seenThreads = new Set();
    const threads = [];
    let fetched = false;
    let disabled = false;
    const maxPages = Math.max(1, opts.maxPages || CONFIG.catalogActivitySearchMaxPages || 20);
    for (let page = 1; page <= maxPages; page++) {
      const url = `${base}/${board}/search/start/${date}/end/${end}/order/desc/page/${page}/`;
      const pageKey = activityPageCacheKey(board, date, base, page);
      const cachedPage = !opts.force && cacheGet(pageKey);
      let pagePosts = null;
      let fromCache = false;
      if (cachedPage && Array.isArray(cachedPage.posts)) {
        pagePosts = cachedPage.posts;
        fromCache = true;
        fetched = true;
      } else {
        let html;
        try { html = await gmText(url); }
        catch (e) { return { posts, threads, ok: fetched, error: String(e && e.message || e), base }; }
        fetched = true;
        if (/Just a moment|Enable JavaScript and cookies|cdn-cgi\/challenge-platform/i.test(html)) {
          return { posts, threads, ok: false, error: 'Cloudflare challenge', base };
        }
        if (/does not have search enabled/i.test(html)) {
          disabled = true;
          break;
        }
        pagePosts = parseSearchActivity(html);
        cacheSet(pageKey, { posts: pagePosts, cachedAt: Date.now() });
      }
      if (!pagePosts.length) break;
      let added = 0;
      for (const p of pagePosts) {
        const postKey = p.num || `${p.threadNum}:${p.ts}`;
        if (seenPosts.has(postKey)) continue;
        seenPosts.add(postKey);
        posts.push(p);
        added++;
        if (!seenThreads.has(p.threadNum)) {
          seenThreads.add(p.threadNum);
          threads.push(p.threadNum);
        }
      }
      if (added && opts.onProgress) opts.onProgress(posts, { board, date, base, page, fromCache });
      if (!added) break;
      if (!fromCache && CONFIG.catalogPageDelayMs) await sleep(CONFIG.catalogPageDelayMs);
    }
    return { posts, threads, ok: fetched && !disabled, disabled, base };
  }

  async function enumerateDay(board, date, opts = {}) {
    const key = indexCacheKey(board, date);
    const cached = cacheGet(key);
    const force = opts.force || tinyCatalogOps(cached) || (Array.isArray(cached) && !cached.length);
    if (cached && !force) return opts.includeLocal === false ? cached : mergeLocalOps(cached, board, date);

    const all = [];
    const seen = new Set();
    let searched = false;
    const mergeOps = (ops) => {
      let added = false;
      for (const op of ops || []) {
        if (!op || !op.num || seen.has(op.num)) continue;
        seen.add(op.num);
        all.push(op);
        added = true;
      }
      if (added && opts.onProgress) opts.onProgress(sortedUniqueOps(all), { board, date });
      return added;
    };

    let fullyEnumerated = false;
    for (const base of searchArchivesForBoard(board)) {
      const result = await enumerateArchiveDay(board, date, base, {
        force,
        onProgress: (partial) => { mergeOps(partial); }
      });
      if (result.disabled) {
        cacheDebug('warn', 'archive HTML search disabled', { board, date, base });
        continue;
      }
      if (!result.ok || result.error) {
        cacheDebug('warn', 'archive HTML search failed', { board, date, base, error: result.error });
        continue;
      }
      searched = true;
      fullyEnumerated = true;
      mergeOps(result.ops);
      // One archive's complete answer is the day's OP list — the mirrors
      // carry the same data, so asking them too just doubles the traffic
      // that gets us rate limited. They remain failover for errors above.
      break;
    }

    const ops = sortedUniqueOps(all);
    // Only persist complete enumerations. Caching a list truncated by a
    // mid-pagination throw (rate limit, outage) would pin a partial day
    // forever — the read path only re-scans empty or tiny lists.
    if (ops.length && fullyEnumerated) cacheSet(key, ops);
    return opts.includeLocal === false ? ops : mergeLocalOps(ops, board, date);
  }

  function tinyCatalogOps(ops) {
    return Array.isArray(ops) && ops.length > 0 && ops.length <= CONFIG.catalogTinyOpsThreshold;
  }

  async function enumerateCatalogCandidates(board, date, opts = {}) {
    const key = catalogCacheKey(board, date);
    const cached = cacheGet(key);
    const cachedOps = Array.isArray(cached) ? cached : (cached && Array.isArray(cached.ops) ? cached.ops : null);
    const endClock = replayEndTs(date);
    const targetClock = Math.min(Number(opts.atClock) || endClock, endClock);
    const target = catalogActiveCapacity();
    const all = [];
    const seen = new Set();
    const seenThreads = new Set();
    const maxDays = Math.max(1, CONFIG.catalogActivityMaxDays || 365);
    let visibleAtTarget = 0;
    let visibleAtEnd = 0;
    let scanDay = null;   // day the backward activity scan is currently on
    let scanOffset = 0;
    const mergeOp = (op) => {
      if (!op || !op.num || seen.has(String(op.num))) return false;
      seen.add(String(op.num));
      seenThreads.add(String(op.num));
      all.push(op);
      return true;
    };
    const currentOps = () => mergeLocalCatalogOps(sortedUniqueOps(all), board, date);
    const recount = () => {
      const ops = currentOps();
      visibleAtTarget = visibleCatalogStatesFromOps(ops, targetClock).length;
      visibleAtEnd = visibleCatalogStatesFromOps(ops, endClock, { browseCatalog: true }).length;
      return ops;
    };
    const emit = (reason = 'catalog') => {
      const ops = recount();
      if (opts.onProgress) opts.onProgress(ops, {
        board, date, reason, visibleAtTarget, visibleAtEnd, target,
        scanDay, scanOffset, maxDays
      });
      return ops;
    };

    if (cachedOps && !opts.force) {
      loadCachedThreadSummariesIntoMemory(board, cachedOps);
      for (const op of cachedOps) mergeOp(op);
      const ops = emit('cached catalog');
      if (cached && cached.complete && !tinyCatalogOps(cachedOps) && !opts.expand) return ops;
    }

    // OPs gathered from per-day OP searches (cheap, paginated HTML that
    // caches forever) so activity threads don't each cost a full thread
    // fetch just to read their OP. Thread fetches remain the fallback for
    // threads created before the scan window (long-lived generals).
    const opByNum = new Map();
    const registerDayOps = (ops) => {
      for (const op of ops || []) if (op && op.num) opByNum.set(String(op.num), op);
    };
    // A provisional summary from search-page data: correct bump order and a
    // same-day lower bound on replies, painted immediately. Hydration
    // replaces it with exact counts when the thread itself arrives.
    const seedProvisionalSummary = (threadNum, op, bumpTs, dayPostCount) => {
      const key = String(threadNum);
      if (engine.threadSummaries.has(key)) return;
      const cached = cachedThreadSummary(board, key);
      if (cached) { rememberThreadSummary(key, cached); return; }
      rememberThreadSummary(key, {
        num: key,
        opTs: op.ts,
        bump: Math.max(op.ts, bumpTs || 0),
        sticky: !!op.sticky,
        deleted: false,
        expiredTs: 0,
        lastTs: Math.max(op.ts, bumpTs || 0),
        replyCount: Math.max(0, dayPostCount || 0),
        imageCount: postHasMedia(op) ? 1 : 0,
        omittedImages: 0,
        provisional: true,
        cachedAt: Date.now()
      });
    };

    try {
      const dayOps = await enumerateDay(board, date, { includeLocal: false });
      registerDayOps(dayOps);
      let added = false;
      for (const op of dayOps || []) if (mergeOp(op)) added = true;
      if (added) emit('selected day ops');
    } catch (e) {
      cacheDebug('warn', 'selected day OP scan failed', { board, date, error: String(e && e.message || e) });
    }

    const addThreadCandidate = async (threadNum, bumpTs, dayPostCount) => {
      if (!threadNum || seenThreads.has(String(threadNum))) return false;
      seenThreads.add(String(threadNum));
      const known = opByNum.get(String(threadNum));
      if (known) {
        if (known.ts > endClock || !mergeOp(known)) return false;
        seedProvisionalSummary(threadNum, known, bumpTs, dayPostCount);
        emit('activity thread');
        return true;
      }
      let result;
      try { result = await fetchThread(board, threadNum, { preferCache: true }); }
      catch (e) { return false; }
      if (!validThreadResult(result)) return false;
      const op = result.posts[0];
      if (!op || !op.num || op.ts > endClock || !mergeOp(op)) return false;
      emit('activity thread');
      return true;
    };

    let scannedDays = 0;
    let scanFailed = false;
    for (let offset = 0; offset < maxDays && (visibleAtTarget < target || visibleAtEnd < target); offset++) {
      scannedDays = offset + 1;
      const day = addDays(date, -offset);
      scanDay = day;
      scanOffset = offset;
      emit('scanning day'); // advance the loading note even on quiet days
      if (offset > 0) {
        // The day's OP search is cached forever and shared with direct
        // visits to that date — registering it here saves a thread fetch
        // per activity thread created that day.
        try { registerDayOps(await enumerateDay(board, day, { includeLocal: false })); }
        catch (e) { /* registry is an optimization; the scan continues */ }
      }
      for (const base of searchArchivesForBoard(board)) {
        const activity = await enumerateArchiveActivityDay(board, day, base, {
          force: opts.force || tinyCatalogOps(cachedOps)
        });
        if (activity.disabled) {
          cacheDebug('warn', 'archive activity search disabled', { board, day, base });
          continue;
        }
        if (!activity.ok) {
          scanFailed = true;
          cacheDebug('warn', 'archive activity search failed', { board, day, base, error: activity.error });
          continue;
        }
        const bumpByThread = new Map();
        const countByThread = new Map();
        for (const p of activity.posts || []) {
          if (!p || !p.threadNum || p.ts > endClock) continue;
          const k = String(p.threadNum);
          bumpByThread.set(k, Math.max(bumpByThread.get(k) || 0, p.ts));
          countByThread.set(k, (countByThread.get(k) || 0) + 1);
        }
        for (const threadNum of activity.threads) {
          await addThreadCandidate(threadNum, bumpByThread.get(String(threadNum)), countByThread.get(String(threadNum)));
          if (visibleAtTarget >= target && visibleAtEnd >= target) break;
        }
        // One archive's answer covers the day — mirrors hold the same data
        // and asking them too is how we got rate limited. They stay as
        // failover when this one errors.
        break;
      }
    }
    sortedUniqueOps(all);
    all.sort((a, b) => a.ts - b.ts || Number(a.num) - Number(b.num));
    recount();
    cacheSet(key, {
      ops: all,
      scannedAt: Date.now(),
      target,
      maxDays,
      visibleAtTarget,
      visibleAtEnd,
      complete: (visibleAtTarget >= target && visibleAtEnd >= target) || (!scanFailed && scannedDays >= maxDays)
    });
    return mergeLocalCatalogOps(all, board, date);
  }

  const _threadFetchCache = new Map();
  async function fetchThreadFresh(board, num) {
    let lastError = 'not found';
    // A network/rate-limit failure on an earlier (better) archive means the
    // result we eventually return may be a worse copy than what exists — mark
    // it degraded so the persistent cache retries it instead of pinning it.
    let sawFetchFailure = false;
    for (const base of threadAPIsFor(board, num)) {
      const url = `${base}/_/api/chan/thread/?board=${board}&num=${num}`;
      let data;
      try { data = await gmJSON(url, 12000); }
      catch (e) { lastError = 'fetch failed'; sawFetchFailure = true; continue; }
      if (!data || data.error || !data[num]) {
        lastError = data && data.error ? data.error : 'not found';
        continue;
      }

      const t = data[num];
      const norm = (p) => ({
        num: String(p.num), ts: Number(p.timestamp), op: p.op === '1' || p.op === 1,
        title: p.title || '', name: p.name || 'Anonymous', trip: p.trip || '',
        email: p.email || '',
        sticky: p.sticky === '1' || p.sticky === 1,
        locked: p.locked === '1' || p.locked === 1,
        deleted: p.deleted === '1' || p.deleted === 1,
        expiredTs: Number(p.timestamp_expired) || 0,
        comment: p.comment || '', fourchan_date: p.fourchan_date || '',
        media: mediaFromApi(p.media, base, board)
      });
      const posts = [norm(t.op)];
      const container = t.posts || {};
      for (const k of Object.keys(container)) posts.push(norm(container[k]));
      posts.sort((a, b) => a.ts - b.ts);
      return sawFetchFailure ? { posts, source: base, degraded: true } : { posts, source: base };
    }
    return { error: lastError };
  }

  function validThreadResult(result) {
    return !!(result && Array.isArray(result.posts) && result.posts.length);
  }
  function threadSummaryFromPosts(posts) {
    if (!Array.isArray(posts) || !posts.length) return null;
    const op = posts[0];
    const replies = posts.slice(1);
    let bump = op.ts;
    for (let i = 0; i < replies.length; i++) {
      if (i >= CONFIG.bumpLimit) break;
      if (!isSagePost(replies[i])) bump = replies[i].ts;
    }
    const omittedImages = replies.filter(postHasMedia).length;
    return {
      num: String(op.num),
      opTs: op.ts,
      bump,
      sticky: !!op.sticky,
      deleted: !!op.deleted,
      expiredTs: op.expiredTs || 0,
      lastTs: posts[posts.length - 1].ts,
      replyCount: replies.length,
      imageCount: posts.filter(postHasMedia).length,
      omittedImages,
      cachedAt: Date.now()
    };
  }
  function validThreadSummary(summary) {
    return !!(summary && summary.num && typeof summary.bump === 'number');
  }
  function rememberThreadSummary(num, summary) {
    if (!validThreadSummary(summary)) return false;
    engine.threadSummaries.set(String(num), summary);
    return true;
  }
  function cachedThreadSummary(board, num) {
    const summary = cacheGet(threadSummaryCacheKey(board, num));
    return validThreadSummary(summary) ? summary : null;
  }
  function cacheThreadSummary(board, num, result) {
    if (!validThreadResult(result)) return null;
    const summary = threadSummaryFromPosts(result.posts);
    if (!summary) return null;
    rememberThreadSummary(num, summary);
    cacheSet(threadSummaryCacheKey(board, num), summary);
    return summary;
  }
  function rememberThreadResult(num, result) {
    if (!validThreadResult(result)) return false;
    const key = String(num);
    engine.replyTimes.set(key, result.posts.map((p) => p.ts));
    engine.threads.set(key, result.posts);
    rememberThreadSummary(num, threadSummaryFromPosts(result.posts));
    return true;
  }
  function cacheThreadResult(board, num, result) {
    if (!validThreadResult(result)) return result;
    cacheThreadSummary(board, num, result);
    return result;
  }
  function loadCachedThreadSummariesIntoMemory(board, ops) {
    let loaded = 0;
    const keys = new Set(cacheKeys());
    for (const op of ops || []) {
      if (!op || !op.num || engine.threadSummaries.has(String(op.num))) continue;
      const cached = keys.size && keys.has(threadSummaryCacheKey(board, op.num)) ? cachedThreadSummary(board, op.num) : null;
      const summary = summaryWithLocalPosts(board, op, cached);
      if (rememberThreadSummary(op.num, summary)) loaded++;
    }
    if (loaded) cacheDebug('debug', 'loaded cached thread summaries into memory', { board, loaded, total: ops.length });
    return loaded;
  }
  function loadCachedThreadsIntoMemory() { return 0; }

  async function fetchThread(board, num, opts = {}) {
    const key = threadCacheKey(board, num);
    let result;
    if (opts.preferCache && !opts.force) {
      const memory = cachedThreadFromMemory(board, num);
      if (memory) {
        result = memory;
        cacheThreadResult(board, num, result);
        result = mergeLocalThreadResult(board, num, result);
        rememberThreadResult(num, result);
        return result;
      }
      const cached = await cachedThreadFull(board, num, { allowStale: true, allowDegraded: true });
      if (cached) {
        result = cached;
        cacheThreadResult(board, num, result);
        result = mergeLocalThreadResult(board, num, result);
        rememberThreadResult(num, result);
        return result;
      }
    }
    if (_threadFetchCache.has(key)) {
      result = await _threadFetchCache.get(key);
    } else {
      const pending = (async () => {
        if (!opts.force) {
          const memory = cachedThreadFromMemory(board, num);
          if (memory) return memory;
          const cached = await cachedThreadFull(board, num, {
            allowStale: !!opts.preferCache,
            allowDegraded: !!opts.preferCache
          });
          if (cached) return cached;
        }
        const fallback = !opts.force ? await cachedThreadFull(board, num, {
          allowStale: true,
          allowDegraded: true
        }) : null;
        let fresh;
        try {
          fresh = await fetchThreadFresh(board, num);
        } catch (e) {
          if (fallback) return {
            ...fallback,
            staleFallback: true,
            networkError: String(e && e.message || e || 'fetch failed')
          };
          throw e;
        }
        if (!validThreadResult(fresh) && fallback) return {
          ...fallback,
          staleFallback: true,
          networkError: fresh && fresh.error || 'fetch failed'
        };
        if (validThreadResult(fresh)) storeThreadFull(board, num, fresh);
        return fresh;
      })().finally(() => _threadFetchCache.delete(key));
      _threadFetchCache.set(key, pending);
      result = await pending;
    }
    cacheThreadResult(board, num, result);
    result = mergeLocalThreadResult(board, num, result);
    rememberThreadResult(num, result);
    return result;
  }

  // ── Comment formatting (era-correct: greentext + quotelinks) ────────────────
  function catalogHydrationQueue(ops) {
    return ops.slice().sort((a, b) => {
      const av = a.ts <= engine.clock, bv = b.ts <= engine.clock;
      if (av !== bv) return av ? -1 : 1;
      return av ? b.ts - a.ts : a.ts - b.ts;
    });
  }

  async function hydrateCatalog(board, ops) {
    const token = engine.catalogToken;
    const limit = Math.max(1, CONFIG.catalogHydrateLimit || ops.length || 1);
    const queue = catalogHydrationQueue(ops)
      .filter((op) => op && op.num && !engine.threads.has(String(op.num)) &&
        !engine.threadPermanentMiss.has(String(op.num)))
      .slice(0, limit);
    if (!queue.length) {
      engine.catalogHydrating = false;
      engine.catalogHydrateDone = 0;
      engine.catalogHydrateTotal = 0;
      updateCatalogSyncNoteOnly();
      return;
    }
    engine.catalogHydrating = true;
    engine.catalogHydrateDone = 0;
    engine.catalogHydrateTotal = queue.length;
    updateCatalogSyncNoteOnly();

    let next = 0;
    const noteEvery = Math.max(1, CONFIG.catalogSyncUpdateEvery || 1);
    const worker = async () => {
      while (token === engine.catalogToken && next < queue.length) {
        const op = queue[next++];
        try {
          const r = await fetchThread(board, op.num, { preferCache: true });
          // A definitive archive answer ("not found") is permanent — the
          // thread was never archived. Transient failures stay retryable.
          if (r && r.error && !/fetch failed|rate limit|timeout/i.test(String(r.error))) {
            engine.threadPermanentMiss.add(String(op.num));
          }
        }
        catch (e) { /* keep hydrating the rest */ }
        finally {
          engine.catalogHydrateDone++;
          if (engine.catalogHydrateDone % noteEvery === 0 || engine.catalogHydrateDone >= engine.catalogHydrateTotal) {
            updateCatalogSyncNoteOnly();
            if (engine.catalogView) scheduleBoardUpdate();
          }
          if (CONFIG.catalogHydrateYieldMs) await sleep(CONFIG.catalogHydrateYieldMs);
        }
      }
    };
    const n = Math.max(1, Math.min(CONFIG.catalogHydrateConcurrency || 1, queue.length || 1));
    await Promise.all(Array.from({ length: n }, worker));

    if (token === engine.catalogToken) {
      engine.catalogHydrating = false;
      updateCatalogSyncNoteOnly();
      scheduleBoardUpdate();
      // Threads that failed (or fell past the per-pass cap) get another pass
      // later — hydration keeps trying until everything reachable is in.
      const missing = ops.filter((op) => op && op.num &&
        !engine.threads.has(String(op.num)) &&
        !engine.threadPermanentMiss.has(String(op.num))).length;
      if (missing) {
        const wait = 45000 + Math.floor(Math.random() * 15000);
        setTimeout(() => {
          if (token === engine.catalogToken && !engine.catalogHydrating) hydrateCatalog(board, ops);
        }, wait);
      }
    }
  }

  function formatComment(raw) {
    if (!raw) return '';
    const esc = raw
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = esc.split('\n').map((line) => {
      let html = line.replace(/&gt;&gt;(\d+)/g,
        (m, n) => `<a class="wb-quotelink" data-num="${n}" href="#p${n}">&gt;&gt;${n}</a>`);
      if (/^\s*&gt;/.test(html) && !/^\s*<a/.test(html.trimStart())) {
        html = `<span class="wb-quote">${html}</span>`;
      }
      return html;
    }).join('<br>');
    return html.replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<span class="wb-spoiler">$1</span>');
  }

  function quoteNumFromLink(a) {
    if (!a) return '';
    const dataNum = a.dataset && a.dataset.num;
    if (dataNum) return dataNum;
    const m = (a.textContent || '').match(/>>\s*(\d+)/);
    return m ? m[1] : '';
  }
  function annotateQuotelinks(scope, opNum, currentNum) {
    if (!scope) return;
    const op = String(opNum || '');
    const current = String(currentNum || '');
    scope.querySelectorAll('.wb-quotelink').forEach((a) => {
      const num = quoteNumFromLink(a);
      if (!num) return;
      a.dataset.num = num;
      a.setAttribute('href', '#p' + num);
      if (op && num === op && current !== op && !/\(OP\)/.test(a.textContent || '')) {
        a.append(document.createTextNode(' (OP)'));
      }
    });
  }

  // The HTML search page hands us comments already formatted by FoolFuuka.
  // Remap its greentext class to ours and make any backlinks inert (the posts
  // they point to aren't on the index), so previews don't navigate to the archive.
  function sanitizePreformatted(html) {
    if (!html) return '';
    return html
      .replace(/class="greentext"/g, 'class="wb-quote"')
      .replace(/class=(["'])spoiler\1/g, 'class="wb-spoiler"')
      .replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<span class="wb-spoiler">$1</span>')
      .replace(/<a\b[^>]*>/g, '<a class="wb-quotelink" href="javascript:void(0)">');
  }

  // ── Replay engine ───────────────────────────────────────────────────────────
  const engine = {
    board: 'g',
    openThread: null,     // num or null (index mode)
    realBanner: null,     // the live 4chan title banner node, relocated into our chrome
    titleBannerFile: '',
    catalogView: false,
    indexPage: 1,
    catalogSort: 'bump',
    ops: [],              // enumerated OPs for the day, sorted by ts
    thread: null,         // {posts:[...]} when a thread is open
    clock: 0,             // current replayed unix time (seconds)
    anchor: null,         // {wall, replay, speed, paused, date, startTime} — the persisted clock epoch
    threadClockOverride: null, // when browsing an off-date thread directly, reveal it fully without moving the global clock
    indexClock: 0,        // last explicit board-page refresh time
    catalogClock: 0,      // last explicit catalog refresh time
    speed: CONFIG.speed,
    paused: false,
    barHidden: false,     // dashboard hidden / minimized
    autoUpdate: true,     // auto-reveal new posts in the open thread
    shownOps: new Set(),  // OP nums already on the index
    shownPosts: new Set(),// post nums already rendered in open thread
    prefetchQueue: [],
    prefetching: false,
    timer: null,
    cards: new Map(),       // num -> { node, op, countEl, previewsEl, sig } for index cards
    catalogCards: new Map(),// num -> { node, sig } for catalog grid cards
    replyTimes: new Map(),  // num -> sorted [post ts...] for bump ordering
    threads: new Map(),     // num -> full posts[] (drives bump order + reply previews)
    threadSummaries: new Map(), // num -> compact persisted catalog state for stable reloads
    threadPermanentMiss: new Set(), // nums the archives definitively don't have — stop re-asking
    catalogHydrating: false,
    catalogHydrateDone: 0,
    catalogHydrateTotal: 0,
    catalogToken: 0,
    catalogLoadPending: null,
    _lastIndexSig: ''       // last rendered index order, to skip needless reflow
  };

  // ── Persistent replay clock ────────────────────────────────────────────────
  // The clock is anchored ONCE — a single (real wall time ⇄ replay time) pin
  // saved to storage — so it survives refreshes. At any instant the replay time
  // is a pure function of how much REAL time has elapsed since that pin, never
  // an accumulator, so reloading recomputes the exact same value. It only resets
  // when you explicitly start a new replay (Go / change the date).
  const CLOCK_KEY = 'clockAnchor';
  function loadAnchor() {
    const a = cacheGet(CLOCK_KEY);
    return (a && typeof a.wall === 'number' && typeof a.replay === 'number') ? a : null;
  }
  function saveAnchor(a) { cacheSet(CLOCK_KEY, a); }
  function clearAnchor() { engine.anchor = null; cacheDelete(CLOCK_KEY); }

  // Replay time right now, derived from the anchor (frozen while paused).
  function currentClock(a = engine.anchor, now = Date.now()) {
    if (!a) return engine.clock || 0;
    if (a.paused) return a.replay;
    return a.replay + ((now - a.wall) / 1000) * (a.speed || 1);
  }
  const _etDateFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  // YYYY-MM-DD for a unix time, in 4chan's timezone (US Eastern).
  function etDateString(unixSec) {
    const parts = _etDateFmt.formatToParts(new Date(unixSec * 1000));
    const g = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${g('year')}-${g('month')}-${g('day')}`;
  }
  // 4chan's clock is US Eastern; +4h ≈ EDT→UTC in summer.
  function replayStartTs(date, startTime) {
    const [hh, mm] = (startTime || '12:00').split(':').map(Number);
    const [y, m, d] = date.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d, hh + 4, mm || 0) / 1000);
  }
  function replayEndTs(date) {
    const [y, m, d] = date.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d + 1, 4, 0, -1) / 1000);
  }
  // Pin a brand-new epoch: replay starts at `replayTs`, anchored to now.
  function anchorAt(replayTs, date, startTime, speed) {
    const a = { wall: Date.now(), replay: replayTs, speed: speed || 1, paused: false,
      board: engine.board, date, startTime: startTime || '12:00' };
    saveAnchor(a);
    return a;
  }
  function anchorEpoch(date, startTime, speed) {
    return anchorAt(replayStartTs(date, startTime), date, startTime, speed);
  }
  // Re-base the anchor to "now" (capturing the current replay time) so speed and
  // pause changes take effect going forward without rewriting the elapsed past.
  function reanchor(patch) {
    if (!engine.anchor) return; // no running epoch to re-base yet
    const now = Date.now();
    const cur = currentClock(engine.anchor, now);
    engine.anchor = { ...(engine.anchor || {}), wall: now, replay: cur, ...patch };
    if (typeof engine.anchor.speed !== 'number') engine.anchor.speed = engine.speed || 1;
    if (!engine.anchor.date) engine.anchor.date = CONFIG.date;
    if (!engine.anchor.startTime) engine.anchor.startTime = CONFIG.startTime;
    saveAnchor(engine.anchor);
    engine.clock = currentClock(engine.anchor, now);
  }
  // Resume the saved epoch if it's for the current date/time; otherwise start one.
  function ensureAnchor() {
    // ONE global clock epoch. ANY saved anchor is resumed — never reset by a
    // reload, a board switch, or opening a thread. The only thing that starts a
    // new epoch is an explicit "Go" (boot({ freshClock:true }) clears it first).
    const saved = loadAnchor();
    engine.anchor = saved || anchorEpoch(CONFIG.date, CONFIG.startTime, engine.speed);
    // The epoch is the source of truth for which 2013 instant we're at, so adopt
    // its origin date/time/speed/pause; the loaded board then matches the clock.
    if (engine.anchor.date) CONFIG.date = engine.anchor.date;
    if (engine.anchor.startTime) CONFIG.startTime = engine.anchor.startTime;
    engine.speed = engine.anchor.speed || engine.speed;
    engine.paused = !!engine.anchor.paused;
    engine.clock = currentClock();
  }
  function startTimer() {
    engine.clock = currentClock();
    if (engine.timer) clearInterval(engine.timer);
    engine.timer = setInterval(tick, 500);
    updateClockDisplay();
  }

  function tick() {
    engine.clock = currentClock();
    updateClockDisplay();
    // Keep the tab title ours even if a late 4chan script tries to reset it.
    if (engine.docTitle && document.title !== engine.docTitle) document.title = engine.docTitle;
    if (engine.openThread) {
      if (engine.autoUpdate) revealThreadPosts();
      refreshUpdateCount();
    }
  }

  // Show "[Update (N)]" when auto-update is off and posts are waiting.
  function refreshUpdateCount() {
    const u = $('#wb-update');
    if (!u || !engine.thread || !engine.thread.posts) return;
    let pending = 0;
    for (const p of engine.thread.posts) {
      if (p.ts <= engine.clock && !engine.shownPosts.has(p.num)) pending++;
    }
    u.textContent = pending ? `[Update (${pending})]` : '[Update]';
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  function insertQuote(num) {
    const box = $('#wb-post-comment');
    if (!box) return false;
    const quote = `>>${num}\n`;
    const start = typeof box.selectionStart === 'number' ? box.selectionStart : box.value.length;
    const end = typeof box.selectionEnd === 'number' ? box.selectionEnd : start;
    box.value = box.value.slice(0, start) + quote + box.value.slice(end);
    const pos = start + quote.length;
    try { box.setSelectionRange(pos, pos); } catch (e) { /* old textarea */ }
    box.focus();
    return true;
  }
  function renderPostNode(p, isOp, opts = {}) {
    const head = el('div', { class: 'wb-postinfo' });
    if (isOp && p.title) head.append(el('span', { class: 'wb-subject' }, p.title), document.createTextNode(' '));
    const nameSpan = el('span', { class: 'wb-name' }, p.name || 'Anonymous');
    head.append(nameSpan);
    if (p.trip) head.append(el('span', { class: 'wb-trip' }, ' ' + p.trip));
    head.append(document.createTextNode(' ' + fourchanStamp(p.ts) + ' '));
    const threadForPost = opts.opNum || (isOp && p.num) || '';
    head.append(el('a', {
      class: 'wb-no',
      href: '#p' + p.num,
      onclick: (e) => {
        if (!engine.openThread && threadForPost) {
          e.preventDefault();
          goThread(threadForPost);
          setTimeout(() => insertQuote(p.num), 200);
        } else if (insertQuote(p.num)) { e.preventDefault(); }
      }
    }, 'No.' + p.num));
    // 4chan's real sticky/closed icons, hotlinked from the same static host
    // the site itself used — not lookalikes.
    if (isOp && p.sticky) head.append(' ', el('img', {
      class: 'wb-threadicon', src: 'https://s.4cdn.org/image/sticky.gif', alt: 'Sticky', title: 'Sticky'
    }));
    if (isOp && p.locked) head.append(' ', el('img', {
      class: 'wb-threadicon', src: 'https://s.4cdn.org/image/closed.gif', alt: 'Closed', title: 'Closed'
    }));
    head.append(el('span', { class: 'wb-backlinks' }));

    const body = el('blockquote', { class: 'wb-comment',
      html: p.preformatted ? sanitizePreformatted(p.comment) : formatComment(p.comment) });
    annotateQuotelinks(body, opts.opNum || (isOp && p.num) || '', p.num);

    let fileInfo = null, imgWrap = null, loadInitialThumb = null;
    if (p.media && (p.media.thumb || p.media.full)) {
      const label = mediaLabel(p.media);
      fileInfo = el('div', { class: 'wb-fileinfo' });
      fileInfo.append(document.createTextNode(activeDesign === '2005' ? 'File : ' : 'File: '));
      const fileLink = el('a', { href: 'javascript:void(0)', target: '_blank' }, label);
      fileInfo.append(fileLink);
      if (p.media.meta) fileInfo.append(document.createTextNode(activeDesign === '2005' ? '-(' + p.media.meta + ')' : ' (' + p.media.meta + ')'));
      const loader = el('span', { class: 'wb-media-loader', title: 'Searching image', 'aria-label': 'Searching image' });
      fileInfo.append(loader);
      const stopLoading = () => { loader.remove(); };
      // Re-show the loader (used while fetching the full image after a click).
      const startLoading = () => { if (!loader.isConnected) fileInfo.append(loader); };
      const img = el('img', { class: 'wb-thumb', alt: p.media.fname || '' });
      img.hidden = true;
      const showMissingPlaceholder = async () => {
        if (img.dataset.placeholder === '1') return;
        stopLoading();
        fileInfo.classList.add('wb-media-unavailable');
        const placeholder = await missingImagePlaceholderBlob(engine.board, `${engine.board}:${p.num}:missing`);
        if (!placeholder || !img.isConnected) return;
        img.dataset.placeholder = '1';
        img.classList.add('wb-missing-placeholder');
        img.classList.remove('wb-expanded', 'wb-thumb-fallback');
        img.hidden = false;
        img.src = placeholder.blob;
        img.title = 'Missing archived image';
      };
      img.addEventListener('error', () => {
        mediaDebug('warn', 'display image failed', {
          board: engine.board,
          num: p.num,
          src: img.src && img.src.startsWith('blob:') ? 'blob:' : img.src
        });
        if (img.dataset.placeholder === '1') {
          img.hidden = true;
          return;
        }
        showMissingPlaceholder();
      });
      const useResolvedMedia = (r, linkKind = 'thumb') => {
        if (!r) return false;
        stopLoading();
        delete img.dataset.placeholder;
        img.classList.remove('wb-missing-placeholder');
        img.title = '';
        img.hidden = false;
        img.src = r.blob;
        if (r.url && (linkKind === 'full' || fileLink.getAttribute('href') === 'javascript:void(0)')) {
          fileLink.href = r.url;
        }
        if (linkKind === 'full' && r.url && !r.thumbFallback) fileLink.dataset.fullResolved = '1';
        return true;
      };
      let fullPrefetch = null;
      const prefetchFull = (eager = false) => {
        if (fullPrefetch || img.dataset.placeholder === '1') return fullPrefetch;
        const cachedFull = cachedPostMediaResult(p, 'full');
        if (cachedFull) {
          fullPrefetch = Promise.resolve(cachedFull);
          return fullPrefetch;
        }
        if (fileLink.dataset.fullResolved === '1') return null;
        const run = () => postMediaBlob(p, 'full').catch(() => null);
        fullPrefetch = eager ? run() : enqueueMediaTask(run);
        return fullPrefetch;
      };
      const scheduleFullPrefetch = () => {
        const run = () => {
          if (img.isConnected && !img.hidden && img.dataset.placeholder !== '1') prefetchFull(false);
        };
        if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 });
        else setTimeout(run, 1500);
      };
      loadInitialThumb = (target) => {
        const cached = cachedPostMediaResult(p, 'thumb');
        if (cached) {
          useResolvedMedia(cached, 'thumb');
          scheduleFullPrefetch();
          return;
        }
        lazyResolvePostMedia(target, p, 'thumb',
          (r) => {
            useResolvedMedia(r, 'thumb');
            scheduleFullPrefetch();
          },
          () => { showMissingPlaceholder(); });
      };
      fileLink.addEventListener('click', async (e) => {
        if (fileLink.dataset.fullResolved === '1') return;
        e.preventDefault();
        const full = await prefetchFull(true);
        if (full && full.url) {
          useResolvedMedia(full, 'full');
          window.open(full.url, '_blank', 'noopener');
        } else if (fileLink.getAttribute('href') !== 'javascript:void(0)') {
          window.open(fileLink.href, '_blank', 'noopener');
        }
      });
      // Click-to-expand works the same on the index and inside a thread.
      let expanded = false;
      img.addEventListener('click', async (e) => {
        e.preventDefault();
        if (img.dataset.placeholder === '1') return;
        if (!expanded) {
          expanded = true;
          img.classList.add('wb-expanded', 'wb-thumb-fallback');
          // Spinner only while a bigger image is actually on its way. If it's
          // already cached it's instant; if the archive only has the thumbnail
          // there's nothing to wait for, so don't sit there saying "loading".
          const haveFull = !!cachedPostMediaResult(p, 'full');
          const fullExists = !!(p.media && p.media.full);
          if (!haveFull && fullExists && fileLink.dataset.fullResolved !== '1') startLoading();
          const full = await prefetchFull(true);
          stopLoading();
          if (expanded && full && img.isConnected && img.dataset.placeholder !== '1') {
            useResolvedMedia(full, 'full');
            img.classList.toggle('wb-thumb-fallback', full.thumbFallback);
          }
        } else if (expanded) {
          expanded = false;
          img.classList.remove('wb-expanded', 'wb-thumb-fallback');
          const thumb = cachedPostMediaResult(p, 'thumb') || await postMediaBlob(p, 'thumb');
          if (!expanded && thumb) useResolvedMedia(thumb, 'thumb');
        }
      });
      imgWrap = img;
    }

    // 4chan post order: info line, then the file (File: text above a left-floated
    // thumb), then the comment that wraps around the thumb.
    const post = el('div', { class: isOp ? 'wb-op' : 'wb-reply', id: 'p' + p.num });
    post.append(head);
    if (fileInfo || imgWrap) {
      const fileDiv = el('div', { class: 'wb-file' });
      if (fileInfo) fileDiv.append(fileInfo);
      if (imgWrap) fileDiv.append(imgWrap);
      post.append(fileDiv);
      if (loadInitialThumb) loadInitialThumb(fileDiv);
    }
    post.append(body);
    wireQuotelinks(post);
    if (isOp) return post;
    // 4chan's reply "sideArrows": a >> marker floated in the post's left gutter.
    return el('div', { class: 'wb-postrow' }, el('span', { class: 'wb-arrows' }, '>>'), post);
  }

  // Jump to a quoted post and flash it the era-correct highlight, the way
  // clicking a >>quotelink did on 4chan. It stays highlighted until you click
  // another link (matching the native :target behaviour).
  function highlightPost(num) {
    document.querySelectorAll('.wb-highlight').forEach((n) => n.classList.remove('wb-highlight'));
    const target = document.getElementById('p' + num);
    if (!target) return false;
    target.classList.add('wb-highlight');
    const overlay = $('#wb-overlay');
    const center = () => target.scrollIntoView({ block: 'center' });
    center();
    // Blob images above the target keep loading and shift the layout — that's why
    // the first jump lands in the wrong place. Re-center while the page settles.
    let tries = 0;
    const settle = () => {
      if (++tries > 6) return;
      const r = target.getBoundingClientRect();
      const vh = overlay ? overlay.clientHeight : window.innerHeight;
      if (Math.abs(r.top + r.height / 2 - vh / 2) > 40) center();
      setTimeout(settle, 110);
    };
    setTimeout(settle, 110);
    return true;
  }
  function wireQuotelinks(scope) {
    scope.querySelectorAll('.wb-quotelink').forEach((a) => {
      if (!a.dataset.num) return;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        highlightPost(a.dataset.num);
      });
    });
  }

  function resetIndexState() {
    engine.shownOps = new Set();
    engine.cards = new Map();
    engine.catalogCards = new Map();
    engine.replyTimes = new Map();
    engine.threads = new Map();
    engine.threadSummaries = new Map();
    engine.threadPermanentMiss = new Set();
    engine.catalogHydrating = false;
    engine.catalogHydrateDone = 0;
    engine.catalogHydrateTotal = 0;
    engine.catalogLoadPending = null;
    engine.catalogToken++;
    engine.indexClock = 0;
    engine.catalogClock = 0;
    engine._lastIndexSig = '';
  }

  function buildThreadCard(op) {
    const open = () => goThread(op.num);
    const post = renderPostNode(op, true, { opNum: op.num });
    // Authentic per-OP "[Reply]" link in the post info line — how you entered a
    // thread from the board index.
    const reply = el('a', { class: 'wb-replylink', href: `/${engine.board}/thread/${op.num}`,
      onclick: (e) => { e.preventDefault(); open(); } }, '[Reply]');
    const info = post.querySelector('.wb-postinfo');
    if (info) info.append(document.createTextNode(' '), reply);
    // The "N replies omitted. Click here to view." line, as 4chan's index read.
    const omitted = el('a', { class: 'wb-omitted', href: `/${engine.board}/thread/${op.num}`,
      onclick: (e) => { e.preventDefault(); open(); } }, '');
    // The last few replies preview below the OP (4chan showed ~3 on the index).
    const previews = el('div', { class: 'wb-previews' });
    const wrap = el('div', { class: 'wb-threadcard' }, post, omitted, previews, el('hr'));
    return { node: wrap, countEl: omitted, previewsEl: previews };
  }

  function postHasMedia(p) {
    return !!(p && p.media && (p.media.thumb || p.media.full));
  }
  function isSagePost(p) {
    return /\bsage\b/i.test((p && p.email) || '');
  }
  function omittedText(posts, images) {
    if (posts <= 0) return '';
    const p = `${posts} post${posts === 1 ? '' : 's'}`;
    const i = images > 0 ? ` and ${images} image${images === 1 ? '' : 's'}` : '';
    return `${p}${i} omitted. Click here to view.`;
  }
  const CATALOG_SORTS = ['bump', 'created', 'lastReply', 'replyCount'];
  function normCatalogSort(sort) {
    return CATALOG_SORTS.includes(sort) ? sort : 'bump';
  }
  function catalogActiveCapacity() {
    return Math.max(CONFIG.indexPages * CONFIG.indexThreadsPerPage,
      CONFIG.catalogActivityThreadTarget || 0);
  }
  function compareCatalogStates(a, b, sort = 'bump') {
    const sticky = (b.sticky ? 1 : 0) - (a.sticky ? 1 : 0);
    if (sticky) return sticky;
    switch (normCatalogSort(sort)) {
      case 'created':
        return (b.creationTs || 0) - (a.creationTs || 0) || Number(b.num) - Number(a.num);
      case 'lastReply':
        return (b.lastReplyTs || 0) - (a.lastReplyTs || 0) || (b.bump || 0) - (a.bump || 0) || Number(b.num) - Number(a.num);
      case 'replyCount':
        return (b.replyCount || 0) - (a.replyCount || 0) || (b.bump || 0) - (a.bump || 0) || Number(b.num) - Number(a.num);
      case 'bump':
      default:
        return (b.bump || 0) - (a.bump || 0) || Number(b.num) - Number(a.num);
    }
  }
  function catalogState(op, atClock = engine.clock, opts = {}) {
    if (!op || op.ts > atClock) return null;
    const hydratedPosts = engine.threads.get(String(op.num));
    const hydrated = !!(hydratedPosts && hydratedPosts.length);
    const summary = hydrated ? null : summaryWithLocalPosts(engine.board, op, engine.threadSummaries.get(String(op.num)));
    const posts = hydrated ? hydratedPosts : [op];
    const browseCatalog = !!opts.browseCatalog;
    const useSummary = !hydrated && validThreadSummary(summary);
    const threadOp = useSummary ? {
      ...op,
      sticky: summary.sticky,
      deleted: summary.deleted,
      expiredTs: summary.expiredTs || 0
    } : (posts[0] || op);

    if ((hydrated || useSummary) &&
      (threadOp.deleted || (threadOp.expiredTs && threadOp.expiredTs <= atClock))) return null;
    if (useSummary) {
      return {
        op: threadOp,
        hydrated: false,
        summarized: true,
        bump: summary.bump,
        creationTs: threadOp.ts,
        lastReplyTs: summary.lastTs || summary.bump || threadOp.ts,
        replyCount: summary.replyCount || 0,
        sticky: !!threadOp.sticky,
        shown: [],
        omittedPosts: summary.replyCount || 0,
        omittedImages: summary.omittedImages || 0,
        imageCount: summary.imageCount || (postHasMedia(op) ? 1 : 0),
        sig: [
          summary.bump,
          'summary',
          summary.replyCount || 0,
          summary.omittedImages || 0,
          summary.imageCount || 0,
          's'
        ].join('|')
      };
    }
    const visible = posts.filter((p) => p.ts <= atClock);
    if (!visible.length) return null;

    const replies = visible.slice(1);
    let bump = threadOp.ts;
    for (let i = 0; i < replies.length; i++) {
      if (i >= CONFIG.bumpLimit) break;
      if (!isSagePost(replies[i])) bump = replies[i].ts;
    }

    const shown = replies.slice(-3);
    const shownNums = new Set(shown.map((p) => p.num));
    const omitted = replies.filter((p) => !shownNums.has(p.num));
    const imageCount = visible.filter(postHasMedia).length;
    const omittedImages = omitted.filter(postHasMedia).length;
    const lastReplyTs = replies.length ? replies[replies.length - 1].ts : threadOp.ts;

    return {
      op: threadOp,
      hydrated,
      bump,
      creationTs: threadOp.ts,
      lastReplyTs,
      replyCount: replies.length,
      sticky: !!threadOp.sticky,
      shown,
      omittedPosts: omitted.length,
      omittedImages,
      imageCount,
      sig: [
        bump,
        shown.map((p) => p.num).join(','),
        omitted.length,
        omittedImages,
        imageCount,
        hydrated ? 1 : 0
      ].join('|')
    };
  }
  function updateCatalogSyncNote(list) {
    let note = $('#wb-catalog-sync', list);
    if (!engine.catalogHydrating) {
      if (note) note.remove();
      return;
    }
    if (!note) {
      note = el('div', { id: 'wb-catalog-sync', class: 'wb-note' });
      list.prepend(note);
    }
    const left = Math.max(0, engine.catalogHydrateTotal - engine.catalogHydrateDone);
    note.textContent = `Syncing threads ${engine.catalogHydrateDone}/${engine.catalogHydrateTotal}` +
      ` (${left} left) — reply counts fill in as each thread arrives...`;
  }
  function updateCatalogSyncNoteOnly() {
    if (engine.openThread) return;
    const host = $('#wb-index') || $('#wb-catalog');
    if (host) updateCatalogSyncNote(host);
  }
  function updateThreadCard(card, state) {
    if (card.countEl) card.countEl.textContent = omittedText(state.omittedPosts, state.omittedImages);
    if (state.sig === card.sig) return;
    card.sig = state.sig;
    card.previewsEl.innerHTML = '';
    for (const r of state.shown) {
      card.previewsEl.append(el('div', { class: 'wb-previewrow' }, renderPostNode(r, false, { opNum: state.num })));
    }
  }
  function commentSummary(p, max = 180) {
    const tmp = document.createElement('div');
    tmp.innerHTML = p && p.preformatted ? sanitizePreformatted(p.comment) : formatComment((p && p.comment) || '');
    const text = tmp.textContent.replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 1) + '...' : text;
  }
  // Truncate a DOM subtree to `budget.n` chars of text, keeping element
  // boundaries intact so spoiler/greentext spans survive.
  function truncateNode(node, budget) {
    for (const child of Array.from(node.childNodes)) {
      if (budget.n <= 0) { child.remove(); continue; }
      if (child.nodeType === 3) {
        const t = child.textContent;
        if (t.length > budget.n) { child.textContent = t.slice(0, budget.n) + '…'; budget.n = 0; }
        else budget.n -= t.length;
      } else if (child.nodeType === 1) {
        truncateNode(child, budget);
      } else {
        child.remove();
      }
    }
  }
  // Like commentSummary but keeps the HTML, so catalog teasers render real
  // spoiler bars and greentext instead of leaking the text in the clear.
  function commentTeaserHTML(p, max = 180) {
    const tmp = document.createElement('div');
    tmp.innerHTML = p && p.preformatted ? sanitizePreformatted(p.comment) : formatComment((p && p.comment) || '');
    truncateNode(tmp, { n: max });
    return tmp.innerHTML;
  }
  function visibleCatalogStatesFromOps(ops, atClock = engine.clock, opts = {}) {
    const states = [];
    for (const op of ops || []) {
      if (op.ts > atClock) break;
      const state = catalogState(op, atClock, opts);
      if (state) states.push({ ...state, num: op.num });
    }
    // Natural archive turnover: a thread is active until enough other threads
    // bump ahead of it to push it past the board/catalog capacity. No arbitrary
    // age cutoff; month-long threads survive as long as their bump keeps them in.
    states.sort((a, b) => compareCatalogStates(a, b, 'bump'));
    const active = states.slice(0, catalogActiveCapacity());
    active.sort((a, b) => compareCatalogStates(a, b, opts.catalogSort || 'bump'));
    return active;
  }
  function visibleCatalogStates(atClock = engine.clock, opts = {}) {
    return visibleCatalogStatesFromOps(engine.ops, atClock, opts);
  }
  function clampIndexPage(page) {
    const n = Number(page) || 1;
    return Math.max(1, Math.min(CONFIG.indexPages, Math.floor(n)));
  }
  function indexPath(page = engine.indexPage) {
    const p = clampIndexPage(page);
    return p <= 1 ? `/${engine.board}/` : `/${engine.board}/${p}`;
  }
  function refreshIndexSnapshot() {
    engine.indexClock = engine.clock;
    engine._lastIndexSig = '';
    updateIndex();
  }
  function refreshCatalogSnapshot() {
    engine.catalogClock = replayEndTs(CONFIG.date);
    updateCatalog();
  }
  function refreshCatalogData() {
    refreshCatalogSnapshot();
    ensureCatalogViewOps({ expand: true });
  }
  function refreshCurrentBoardSnapshot() {
    if (engine.catalogView) refreshCatalogSnapshot();
    else refreshIndexSnapshot();
  }
  function buildCatalogCard(state) {
    const op = state.op;
    const open = () => goThread(state.num);
    const thumb = el('div', { class: 'wb-catalog-thumb' });
    if (postHasMedia(op)) {
      const loader = el('span', { class: 'wb-media-loader wb-catalog-loader', title: 'Searching image', 'aria-label': 'Searching image' });
      thumb.append(loader);
      const stopCatalogLoading = () => { loader.remove(); };
      const img = el('img', { alt: mediaLabel(op.media) });
      img.hidden = true;
      const showCatalogPlaceholder = async () => {
        if (img.dataset.placeholder === '1') return;
        stopCatalogLoading();
        const placeholder = await missingImagePlaceholderBlob(engine.board, `${engine.board}:${op.num}:catalog-missing`);
        if (!placeholder || !img.isConnected) {
          thumb.classList.add('wb-catalog-noimage');
          return;
        }
        img.dataset.placeholder = '1';
        img.classList.add('wb-missing-placeholder');
        img.hidden = false;
        img.src = placeholder.blob;
        img.title = 'Missing archived image';
        thumb.classList.remove('wb-catalog-noimage');
        thumb.classList.add('wb-catalog-missing');
      };
      img.addEventListener('error', () => {
        mediaDebug('warn', 'catalog display image failed', {
          board: engine.board,
          num: op.num,
          src: img.src && img.src.startsWith('blob:') ? 'blob:' : img.src
        });
        if (img.dataset.placeholder === '1') {
          img.hidden = true;
          thumb.classList.add('wb-catalog-noimage');
          return;
        }
        showCatalogPlaceholder();
      });
      const cached = cachedPostMediaResult(op, 'thumb');
      if (cached) {
        stopCatalogLoading();
        delete img.dataset.placeholder;
        img.classList.remove('wb-missing-placeholder');
        img.title = '';
        img.src = cached.blob;
        img.hidden = false;
      } else {
        lazyResolvePostMedia(thumb, op, 'thumb',
          (r) => {
            stopCatalogLoading();
            delete img.dataset.placeholder;
            img.classList.remove('wb-missing-placeholder');
            img.title = '';
            img.src = r.blob;
            img.hidden = false;
          },
          () => { showCatalogPlaceholder(); });
      }
      img.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });
      thumb.append(img);
    } else {
      thumb.classList.add('wb-catalog-noimage');
    }
    const meta = el('div', { class: 'wb-catalog-meta' }, `R: ${state.omittedPosts + state.shown.length} / I: ${state.imageCount}`);
    const title = op.title ? el('div', { class: 'wb-catalog-title' }, op.title) : null;
    const text = el('div', { class: 'wb-catalog-text', html: commentTeaserHTML(op) });
    const link = el('a', { class: 'wb-catalog-open', href: `/${engine.board}/thread/${state.num}`,
      onclick: (e) => { e.preventDefault(); open(); } }, `No.${state.num}`);
    const card = el('div', { class: 'wb-catalog-card', onclick: (e) => { e.preventDefault(); open(); } },
      thumb, meta, title, text, link);
    return { node: card, sig: `${state.sig}|${op.title}|${op.comment}` };
  }
  function updateCatalog() {
    const grid = $('#wb-catalog');
    if (!grid) return;
    updateCatalogSyncNote(grid);
    const states = visibleCatalogStates(engine.catalogClock || engine.clock, {
      browseCatalog: true,
      catalogSort: engine.catalogSort
    });
    const visibleNums = new Set(states.map((s) => s.num));

    let empty = $('#wb-catalog-empty', grid);
    if (!states.length) {
      if (!empty) {
        empty = el('div', { id: 'wb-catalog-empty', class: 'wb-note' });
        grid.append(empty);
      }
      empty.textContent = engine.ops.length ? 'No threads visible at this replay time.' : 'Loading catalog...';
    } else if (empty) {
      empty.remove();
    }
    // The loading note is owned by loadBoardOps — it shows live scan
    // progress while threads render and is removed when enumeration ends.

    for (const state of states) {
      let card = engine.catalogCards.get(state.num);
      const sig = `${state.sig}|${state.op.title}|${state.op.comment}`;
      if (!card || card.sig !== sig) {
        const built = buildCatalogCard(state);
        if (card) card.node.replaceWith(built.node);
        card = built;
        engine.catalogCards.set(state.num, card);
      }
      grid.append(card.node);
    }

    for (const [num, card] of engine.catalogCards) {
      if (visibleNums.has(num)) continue;
      card.node.remove();
      engine.catalogCards.delete(num);
    }
  }
  function updateBoardView() {
    if (engine.openThread) return;
    if (engine.catalogView) updateCatalog();
    else updateIndex();
  }
  let _boardUpdateScheduled = false;
  function scheduleBoardUpdate() {
    if (engine.openThread || _boardUpdateScheduled) return;
    _boardUpdateScheduled = true;
    const run = () => {
      _boardUpdateScheduled = false;
      updateBoardView();
    };
    if ('requestAnimationFrame' in window) requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  // Real 4chan orders the index by *bump*. We compute that order only when the
  // board page is explicitly refreshed, then slice the sorted list into pages.
  function updateIndex() {
    const list = $('#wb-index');
    if (!list) return;
    updateCatalogSyncNote(list);

    // Compose the board pages from the active-thread candidate set, then slice
    // it the way 4chan's numbered pages behaved: bump order first, fixed page
    // size next. Older OPs stay eligible when replies keep them alive.
    const clock = engine.indexClock || engine.clock;
    const allStates = visibleCatalogStates(clock, { browseCatalog: true });
    const page = clampIndexPage(engine.indexPage);
    engine.indexPage = page;
    const start = (page - 1) * CONFIG.indexThreadsPerPage;
    const states = allStates.slice(start, start + CONFIG.indexThreadsPerPage);
    for (const state of states) {
      const op = state.op;
      let card = engine.cards.get(state.num);
      if (!card) {
        const built = buildThreadCard(state.op || op);
        card = { node: built.node, op: state.op || op, countEl: built.countEl, previewsEl: built.previewsEl, sig: '' };
        engine.cards.set(state.num, card);
      }
      updateThreadCard(card, state);
      state.node = card.node;
    }

    const visibleNums = new Set(states.map((s) => s.num));
    for (const [num, card] of engine.cards) {
      if (visibleNums.has(num)) continue;
      card.node.remove();
      engine.cards.delete(num);
      engine.shownOps.delete(num);
    }

    let empty = $('#wb-index-empty', list);
    if (!states.length) {
      if (!empty) {
        empty = el('div', { id: 'wb-index-empty', class: 'wb-note' });
        list.append(empty);
      }
      empty.textContent = engine.ops.length ? `No threads on page ${page}.` : 'Loading threads...';
    } else if (empty) {
      empty.remove();
    }
    // The loading note is owned by loadBoardOps — it shows live scan
    // progress while threads render and is removed when enumeration ends.

    const sig = `${page}:full:${states.map((o) => o.num).join(',')}`;
    if (sig !== engine._lastIndexSig) {
      engine._lastIndexSig = sig;
      for (const o of states) list.append(o.node); // append() moves existing nodes
    }
  }

  function revealThreadPosts() {
    const wrap = $('#wb-thread-posts');
    if (!wrap || !engine.thread || engine.thread.error) return;
    const clk = engine.threadClockOverride || engine.clock;
    for (const p of engine.thread.posts) {
      if (p.ts > clk) break;
      if (engine.shownPosts.has(p.num)) continue;
      engine.shownPosts.add(p.num);
      const node = renderPostNode(p, p.op, { opNum: engine.thread && engine.thread.posts && engine.thread.posts[0] && engine.thread.posts[0].num });
      wrap.append(node);
      addBacklinksFor(p); // drop ">>this" onto every post this one quoted
    }
  }

  // When a post quotes earlier posts (>>num), add a blue ">>thisNum" backlink
  // onto each quoted post, so you can see who replied to it and click across.
  function addBacklinksFor(p) {
    const quoted = new Set((String(p.comment).match(/>>(\d+)/g) || []).map((s) => s.slice(2)));
    for (const qnum of quoted) {
      const target = document.getElementById('p' + qnum);
      if (!target) continue;
      const bl = target.querySelector('.wb-backlinks');
      if (!bl || bl.querySelector(`a[data-num="${p.num}"]`)) continue;
      const a = el('a', { class: 'wb-quotelink wb-backlink', 'data-num': p.num, href: '#p' + p.num }, '>>' + p.num);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        highlightPost(p.num);
      });
      bl.append(' ', a);
    }
  }

  function goThread(num) {
    // Push a real history entry so the browser Back button returns to the index
    // instead of leaving 4chan, then render the thread.
    engine.catalogView = false;
    history.pushState({ wb: 'thread', num }, '', `/${engine.board}/thread/${num}`);
    openThread(num);
  }

  async function openThread(num, opts = {}) {
    engine.openThread = num;
    engine.threadClockOverride = null; // default: this thread plays on the live global clock
    engine.catalogView = false;
    engine.shownPosts = new Set();
    engine.thread = { posts: [] };
    renderShell();
    const loading = $('#wb-thread-posts');
    if (loading) loading.append(el('div', { class: 'wb-note' }, 'Loading…'));
    // Keep trying until the thread arrives. Rate limits lift and outages
    // pass — a thread view must never die on its loading note waiting for a
    // manual Update click. Only navigating away stops the loop.
    let t = null;
    for (let attempt = 0; ; attempt++) {
      if (String(engine.openThread) !== String(num)) return; // navigated away
      try {
        t = await fetchThread(engine.board, num, { preferCache: true });
        // "fetch failed" is the all-archives-unreachable verdict — transient,
        // so retry. Real archive answers ("not found") render below.
        if (t && t.error && /fetch failed|rate limit|timeout/i.test(String(t.error))) {
          throw new Error(String(t.error));
        }
        break;
      } catch (e) {
        const wait = Math.min(45000, 4000 * Math.pow(1.6, attempt)) + Math.floor(Math.random() * 2000);
        const host = $('#wb-thread-posts');
        if (host) {
          host.innerHTML = '';
          host.append(el('div', { class: 'wb-note' },
            `Archives aren't answering (${String(e && e.message || e).slice(0, 100)}). Retrying in ${Math.round(wait / 1000)}s…`));
        }
        await sleep(wait);
      }
    }
    if (String(engine.openThread) !== String(num)) return;
    engine.thread = t;
    const host = $('#wb-thread-posts');
    if (host) host.innerHTML = '';
    if (t.error || !t.posts || !t.posts.length) {
      if (host) host.append(el('div', { class: 'wb-note' },
        `Thread not available in the archive (${t.error || 'empty'}).`));
      return;
    }
    // A thread URL carries no date. When we land on one directly:
    //  - if an epoch is already running (e.g. you just refreshed a thread you
    //    were watching), RESUME it — never reset the clock on reload;
    //  - only when there's no epoch yet (a freshly pasted thread link) do we pin
    //    a new epoch at the OP's own timestamp, so the thread plays from its top.
    if (opts.startFromOP) {
      const opTs = t.posts[0].ts;
      const opDate = etDateString(opTs);
      const existing = loadAnchor();
      if (existing) {
        // A clock is already running. It is GLOBAL and must never be reset by
        // opening a thread — resume it untouched.
        engine.anchor = existing;
        engine.speed = existing.speed || engine.speed;
        engine.paused = !!existing.paused;
        CONFIG.date = existing.date || opDate;
        // If this thread is from a different day than the running clock, show it
        // fully via a local view-clock instead of dragging the global clock to it.
        if (existing.date !== opDate) engine.threadClockOverride = replayEndTs(opDate);
      } else {
        // First-ever use via a pasted thread link: pin the one global epoch at
        // this thread's OP so it plays from the top.
        CONFIG.date = opDate;
        engine.anchor = anchorAt(opTs - 5, CONFIG.date, CONFIG.startTime, engine.speed);
        saveSettings();
      }
      const di = $('#wb-date'); if (di) di.value = CONFIG.date;
      startTimer();
      const token = engine.catalogToken;
      const board = engine.board;
      const date = CONFIG.date;
      const onProgress = (ops) => {
        if (token !== engine.catalogToken || board !== engine.board || date !== CONFIG.date || engine.openThread) return;
        engine.ops = ops;
        refreshCurrentBoardSnapshot();
      };
      enumerateCatalogCandidates(board, date, { atClock: engine.clock, onProgress }).then((ops) => {
        if (token !== engine.catalogToken || board !== engine.board || date !== CONFIG.date) return;
        engine.ops = ops;
        loadCachedThreadSummariesIntoMemory(board, ops);
        loadCachedThreadsIntoMemory(board, ops);
        if (!engine.openThread) refreshCurrentBoardSnapshot();
        hydrateCatalog(board, ops);
      }); // ready for "back to index"
    }
    revealThreadPosts();
    updateTitle(); // now that the OP is loaded, use its subject in the tab
  }

  // Render the board index (no history change). Used on popstate / Back.
  function showIndexView(opts = {}) {
    engine.openThread = null;
    engine.threadClockOverride = null;
    engine.catalogView = false;
    engine.indexPage = clampIndexPage(opts.page || engine.indexPage || 1);
    engine.thread = null;
    engine.shownOps = new Set();
    engine.cards = new Map();
    engine._lastIndexSig = '';   // keep replyTimes/threads so fetched threads bump instantly
    renderShell();
    if (opts.refresh === false) updateIndex();
    else refreshIndexSnapshot();
  }

  function showCatalogView(opts = {}) {
    engine.openThread = null;
    engine.threadClockOverride = null;
    engine.catalogView = true;
    engine.thread = null;
    engine.catalogCards = new Map();
    renderShell();
    if (opts.refresh === false) updateCatalog();
    else refreshCatalogSnapshot();
    ensureCatalogViewOps();
  }

  async function ensureCatalogViewOps(opts = {}) {
    if (!engine.catalogView) return;
    const force = !!opts.force || tinyCatalogOps(engine.ops);
    if (engine.ops.length && !force && !opts.expand) return;
    if (engine.catalogLoadPending) return engine.catalogLoadPending;

    const token = engine.catalogToken;
    const board = engine.board;
    const date = CONFIG.date;
    engine.catalogLoadPending = (async () => {
      const ops = await enumerateCatalogCandidates(board, date, {
        force,
        atClock: replayEndTs(date),
        onProgress: (partial) => {
          if (token !== engine.catalogToken || board !== engine.board || date !== CONFIG.date || !engine.catalogView) return;
          engine.ops = partial;
          refreshCatalogSnapshot();
        }
      });
      if (token !== engine.catalogToken || board !== engine.board || date !== CONFIG.date || !engine.catalogView) return;
      engine.ops = ops;
      loadCachedThreadSummariesIntoMemory(board, ops);
      loadCachedThreadsIntoMemory(board, ops);
      refreshCatalogSnapshot();
      hydrateCatalog(board, ops);
    })().finally(() => {
      if (token === engine.catalogToken) engine.catalogLoadPending = null;
    });
    return engine.catalogLoadPending;
  }

  function goIndex(page = 1) {
    const p = clampIndexPage(page);
    history.pushState({ wb: 'index', page: p }, '', indexPath(p));
    showIndexView({ page: p, refresh: true });
  }

  function goCatalog() {
    history.pushState({ wb: 'catalog' }, '', `/${engine.board}/catalog`);
    showCatalogView({ refresh: true });
  }

  // [Return] / backing out of a thread just pops history; the popstate handler
  // re-renders the index. (boot seeds an index entry so this never leaves 4chan.)
  function backToIndex() { history.back(); }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
  }
  function imageDimensions(dataURL) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = dataURL;
    });
  }
  async function localMediaFromFile(file) {
    if (!file) return null;
    const okType = /^image\/(?:gif|jpe?g|png)$/i.test(file.type || '') ||
      /\.(?:gif|jpe?g|png)$/i.test(file.name || '');
    if (!okType) throw new Error('Supported file types are GIF, JPG, and PNG.');
    if (file.size > CONFIG.localPostMaxImageBytes) {
      throw new Error(`Maximum local file size is ${Math.floor(CONFIG.localPostMaxImageBytes / 1024)} KB.`);
    }
    const dataURL = await readFileAsDataURL(file);
    const dim = await imageDimensions(dataURL);
    const meta = dim.w && dim.h ? `${dim.w}x${dim.h}` : `${Math.max(1, Math.ceil(file.size / 1024))} KB`;
    return {
      thumb: dataURL,
      full: dataURL,
      localDataURL: dataURL,
      fname: file.name || 'upload',
      meta,
      mediaW: dim.w || '',
      mediaH: dim.h || '',
      mediaSize: file.size || ''
    };
  }
  function postClockForSubmit(threadNum, isReply) {
    let ts = Math.floor(engine.threadClockOverride || engine.clock || currentClock() || replayStartTs(CONFIG.date, CONFIG.startTime));
    if (isReply) {
      const posts = (engine.thread && String(engine.openThread) === String(threadNum) && engine.thread.posts) ||
        engine.threads.get(String(threadNum)) || [];
      const op = posts.find((p) => p && p.op) || posts[0];
      if (op && op.ts) ts = Math.max(ts, op.ts + 1);
    }
    return ts;
  }
  function absorbLocalPost(post) {
    if (!post || post.board !== engine.board) return;
    if (post.op) engine.ops = sortedUniqueOps([...engine.ops, post]);

    const threadNum = String(post.threadNum);
    const currentPosts = (engine.thread && String(engine.openThread) === threadNum && engine.thread.posts) ||
      engine.threads.get(threadNum) || [];
    const merged = mergeThreadPosts(currentPosts, [post]);
    if (merged.length && merged[0].op) {
      if (engine.thread && String(engine.openThread) === threadNum) engine.thread = { ...(engine.thread || {}), posts: merged };
      rememberThreadResult(threadNum, { posts: merged, source: 'local' });
    } else {
      const op = engine.ops.find((o) => String(o.num) === threadNum);
      const summary = summaryWithLocalPosts(engine.board, op, engine.threadSummaries.get(threadNum));
      rememberThreadSummary(threadNum, summary);
    }
    engine._lastIndexSig = '';
  }
  function setPostFormMessage(form, text, isError = false) {
    const msg = $('.wb-postform-msg', form);
    if (!msg) return;
    msg.textContent = text || '';
    msg.classList.toggle('wb-postform-error', !!isError);
  }
  async function handleLocalPostSubmit(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = ($('#wb-post-name', form) || {}).value || '';
    const email = ($('#wb-post-email', form) || {}).value || '';
    const subject = ($('#wb-post-subject', form) || {}).value || '';
    const commentEl = $('#wb-post-comment', form);
    const fileEl = $('#wb-post-file', form);
    const password = ($('#wb-post-password', form) || {}).value || '';
    const comment = commentEl ? commentEl.value : '';
    const file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
    const isReply = !!engine.openThread;

    if (!comment.trim() && !file) {
      setPostFormMessage(form, 'Error: Comment or file required.', true);
      return;
    }

    const submit = $('button[type="submit"]', form);
    if (submit) submit.disabled = true;
    setPostFormMessage(form, 'Posting...', false);
    try {
      const board = engine.board;
      const store = localPostStore(board);
      const num = nextLocalPostNum(store);
      const threadNum = isReply ? String(engine.openThread) : num;
      const ts = postClockForSubmit(threadNum, isReply);
      const media = await localMediaFromFile(file);
      const post = {
        board,
        num,
        threadNum,
        ts,
        date: etDateString(ts),
        op: !isReply,
        title: isReply ? '' : subject.trim(),
        name: name.trim() || 'Anonymous',
        trip: '',
        email: email.trim(),
        sticky: false,
        locked: false,
        deleted: false,
        expiredTs: 0,
        comment,
        preformatted: false,
        fourchan_date: fourchanStamp(ts),
        media,
        local: true
      };
      store.posts.push(post);
      if (!saveLocalPostStore(board, store)) throw new Error('Could not save local post.');
      savePostIdentity({ name, email, password });
      absorbLocalPost(post);

      if (commentEl) commentEl.value = '';
      const subjectEl = $('#wb-post-subject', form);
      if (subjectEl) subjectEl.value = '';
      if (fileEl) fileEl.value = '';
      setPostFormMessage(form, `Posted No.${num}`, false);

      if (post.op) {
        history.pushState({ wb: 'thread', num }, '', `/${board}/thread/${num}`);
        await openThread(num);
      } else if (engine.thread && String(engine.openThread) === threadNum) {
        engine.shownPosts.delete(num);
        revealThreadPosts();
        refreshUpdateCount();
        updateTitle();
      } else {
        scheduleBoardUpdate();
      }
    } catch (err) {
      setPostFormMessage(form, `Error: ${err && err.message ? err.message : err}`, true);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  // ── UI shell ────────────────────────────────────────────────────────────────
  function updateClockDisplay() {
    const c = $('#wb-clock');
    if (c) c.textContent = easternClock(engine.clock);
  }

  // The dead-thread URL we sit on makes the browser tab read "404 Not Found";
  // overwrite it with an era-correct 4chan title for whatever view is showing.
  function updateTitle() {
    const name = BOARD_NAMES[engine.board] || engine.board.toUpperCase();
    let label;
    if (engine.openThread) {
      const op = engine.thread && engine.thread.posts && engine.thread.posts[0];
      label = (op && (op.title || commentSummary(op, 60))) || name;
    } else if (engine.catalogView) {
      label = 'Catalog';
    } else {
      label = name;
    }
    const t = `/${engine.board}/ - ${label} - 4chan`;
    engine.docTitle = t;
    if (document.title !== t) document.title = t;
  }

  function saveSettings() {
    cacheSet('settings', {
      board: engine.board, date: CONFIG.date, startTime: CONFIG.startTime,
      speed: engine.speed, barHidden: engine.barHidden, autoUpdate: engine.autoUpdate,
      colors: activeColors, design: activeDesign, catalogSort: engine.catalogSort,
      mediaDebug: !!CONFIG.mediaDebug, cacheDebug: !!CONFIG.cacheDebug
    });
  }

  function setBarHidden(v) {
    engine.barHidden = v;
    const root = $('#wb-overlay');
    if (root) root.classList.toggle('wb-min', v);
    saveSettings();
  }

  function renderControlBar() {
    const bar = el('div', { id: 'wb-bar' });

    const boardInp = el('input', { id: 'wb-board', value: engine.board, size: 3 });
    const dateInp = el('input', { id: 'wb-date', type: 'date', value: CONFIG.date });
    const timeInp = el('input', { id: 'wb-time', type: 'time', value: CONFIG.startTime });
    const go = el('button', { onclick: () => {
      engine.board = (boardInp.value || 'g').replace(/[^a-z0-9]/gi, '').toLowerCase();
      CONFIG.date = dateInp.value;
      CONFIG.startTime = timeInp.value || '12:00';
      saveSettings();
      boot({ freshClock: true }); // explicit (re)start → pin a new epoch from now
    } }, 'Go');

    const pause = el('button', { id: 'wb-pause', onclick: () => {
      engine.paused = !engine.paused;
      reanchor({ paused: engine.paused });
      pause.textContent = engine.paused ? 'Resume' : 'Pause';
    } }, engine.paused ? 'Resume' : 'Pause');

    const speedSel = el('select', { id: 'wb-speed', onchange: (e) => {
      engine.speed = Number(e.target.value);
      reanchor({ speed: engine.speed });
    } });
    for (const s of [1, 5, 30, 60, 300, 1800]) {
      const o = el('option', { value: s }, s + 'x');
      if (s === engine.speed) o.selected = true;
      speedSel.append(o);
    }

    const colorSel = el('select', { id: 'wb-color-sel', onchange: (e) => { applyTheme(e.target.value); saveSettings(); } });
    for (const [val, label] of [['yotsublue', 'Yotsuba B'], ['yotsuba', 'Yotsuba'], ['tomorrow', 'Tomorrow']]) {
      const o = el('option', { value: val }, label);
      if (val === activeColors) o.selected = true;
      colorSel.append(o);
    }
    const designSel = el('select', { id: 'wb-design-sel', onchange: (e) => { applyDesign(e.target.value); saveSettings(); } });
    for (const [val, label] of [['2012', '2012'], ['2005', '2005']]) {
      const o = el('option', { value: val }, label);
      if (val === activeDesign) o.selected = true;
      designSel.append(o);
    }
    const catalogSortSel = el('select', { id: 'wb-catalog-sort', onchange: (e) => {
      engine.catalogSort = normCatalogSort(e.target.value);
      saveSettings();
      if (engine.catalogView) updateCatalog();
    } });
    for (const [val, label] of [['bump', 'Bump order'], ['created', 'Creation date'], ['lastReply', 'Last reply'], ['replyCount', 'Reply count']]) {
      const o = el('option', { value: val }, label);
      if (val === normCatalogSort(engine.catalogSort)) o.selected = true;
      catalogSortSel.append(o);
    }

    const hide = el('button', { onclick: () => setBarHidden(true) }, 'Hide');
    bar.append(
      el('label', {}, 'board /', boardInp, '/'),
      el('label', {}, ' date ', dateInp),
      el('label', {}, ' time ', timeInp),
      go,
      el('label', {}, ' speed ', speedSel),
      el('label', {}, ' colors ', colorSel),
      el('label', {}, ' design ', designSel),
      el('label', {}, ' catalog ', catalogSortSel),
      pause, hide,
      el('span', { id: 'wb-ratelimit' }, ''),
      el('span', { id: 'wb-clock' }, '')
    );
    return bar;
  }

  // Switch to another board's replay — keeps the running clock epoch (same date).
  function switchBoard(b) {
    b = String(b || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!b) return;
    engine.board = b;
    engine.openThread = null;
    engine.catalogView = false;
    engine.indexPage = 1;
    saveSettings();
    history.pushState({ wb: 'index' }, '', `/${b}/`);
    boot();
  }

  const TITLE_BANNER_BASE = 'https://s.4cdn.org/image/title/';
  const DEFAULT_TITLE_BANNER = '61.gif';
  function normalizeTitleBannerFile(file) {
    file = String(file || '').trim().replace(/^.*\/image\/title\//, '').split(/[?#]/)[0];
    return /^[a-z0-9_.-]+\.(?:gif|png|jpe?g|webp)$/i.test(file) ? file : '';
  }
  function currentTitleBannerFile(node) {
    if (!node) return '';
    const fromData = normalizeTitleBannerFile(node.getAttribute('data-src'));
    if (fromData) return fromData;
    const img = node.querySelector('img');
    return img ? normalizeTitleBannerFile(img.getAttribute('src')) : '';
  }
  function titleBannerURL(file) {
    file = normalizeTitleBannerFile(file);
    return file ? TITLE_BANNER_BASE + file : '';
  }
  function setTitleBannerFile(file) {
    file = normalizeTitleBannerFile(file);
    if (!file || !engine.realBanner) return false;
    let img = engine.realBanner.querySelector('img');
    if (!img) {
      img = el('img', { alt: '4chan' });
      engine.realBanner.textContent = '';
      engine.realBanner.append(img);
    }
    engine.realBanner.setAttribute('data-src', file);
    img.src = titleBannerURL(file);
    engine.titleBannerFile = file;
    return true;
  }
  function titleBannerFromHTML(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const node = doc.querySelector('#bannerCnt');
      const fromNode = currentTitleBannerFile(node);
      if (fromNode) return fromNode;
      const img = doc.querySelector('img[src*="/image/title/"]');
      return img ? normalizeTitleBannerFile(img.getAttribute('src')) : '';
    } catch (e) {
      return '';
    }
  }
  async function shuffleTitleBanner() {
    if (!engine.realBanner) return;
    const board = (engine.board || 'g').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'g';
    const url = new URL(`/${board}/`, location.origin);
    url.searchParams.set('_oldchan_title', String(Date.now()));
    try {
      const html = await gmText(url.href);
      const file = titleBannerFromHTML(html);
      if (file) setTitleBannerFile(file);
    } catch (e) {
      // Keep the current title if the live board page cannot be fetched.
    }
  }
  function prepareTitleBanner() {
    if (!engine.realBanner) {
      engine.realBanner = el('div', { id: 'bannerCnt', class: 'title desktop', 'data-src': DEFAULT_TITLE_BANNER });
    }
    engine.realBanner.classList.add('wb-title-banner');
    const file = currentTitleBannerFile(engine.realBanner) || engine.titleBannerFile || DEFAULT_TITLE_BANNER;
    if (file) setTitleBannerFile(file);
    if (!engine.realBanner.__oldchanTitleClick) {
      engine.realBanner.__oldchanTitleClick = true;
      engine.realBanner.setAttribute('title', 'Click for another title');
      engine.realBanner.addEventListener('click', (e) => {
        e.preventDefault();
        shuffleTitleBanner();
      });
    }
    return engine.realBanner;
  }

  // The 4chan-style top chrome: the bracketed board list plus any archive-only
  // supported boards, the [Settings] [Search] [Mobile] [Home] links, and the
  // genuine rotating banner relocated from the live page.
  function renderChrome() {
    const chrome = el('div', { id: 'wb-chrome' });
    const nav = el('div', { id: 'wb-boardnav' });
    // Float the right-hand links first so they pin to the top-right corner while
    // the board list flows to their left and wraps full-width beneath.
    const mk = (label, fn) => el('a', { class: 'wb-boardlink', href: 'javascript:void(0)',
      onclick: (e) => { e.preventDefault(); fn(); } }, `[${label}]`);
    nav.append(el('span', { id: 'wb-navright' },
      mk('Settings', () => setBarHidden(!engine.barHidden)), ' ',
      mk('Search', () => { const s = $('#wb-board'); if (s) s.focus(); }), ' ',
      mk('Mobile', () => {}), ' ',
      mk('Home', () => goIndex(1))));
    for (const group of BOARD_NAV_GROUPS) {
      const span = el('span', { class: 'wb-boardgroup' });
      span.append('[ ');
      group.forEach((b, i) => {
        if (i) span.append(' / ');
        span.append(el('a', { class: 'wb-boardlink', href: `/${b}/`, title: BOARD_NAMES[b] || b,
          onclick: (e) => { e.preventDefault(); switchBoard(b); } }, b));
      });
      span.append(' ] ');
      nav.append(span);
    }
    chrome.append(nav);

    const banner = el('div', { id: 'wb-banner' });
    const titleBanner = prepareTitleBanner();
    if (titleBanner) banner.append(titleBanner);
    chrome.append(banner);
    return chrome;
  }

  function renderPostForm() {
    const identity = loadPostIdentity();
    const isReply = !!engine.openThread;
    const form = el('form', { id: 'wb-postform', onsubmit: handleLocalPostSubmit });
    const table = el('table', { class: 'wb-postform-table' });
    const row = (label, ...inputs) => {
      const tr = el('tr');
      tr.append(el('td', { class: 'wb-postform-label' }, label));
      const td = el('td', { class: 'wb-postform-input' });
      for (const inp of inputs) td.append(inp);
      tr.append(td);
      table.append(tr);
    };
    row('Name', el('input', { id: 'wb-post-name', name: 'name', type: 'text', size: 28, value: identity.name }));
    row('E-mail', el('input', { id: 'wb-post-email', name: 'email', type: 'text', size: 28, value: identity.email }));
    row('Subject',
      el('input', { id: 'wb-post-subject', name: 'sub', type: 'text', size: 24, value: '' }),
      document.createTextNode(' '),
      el('button', { type: 'submit' }, isReply ? 'Reply' : 'Submit'));
    row('Comment', el('textarea', { id: 'wb-post-comment', name: 'com', rows: 4, cols: 48 }));
    row('File', el('input', { id: 'wb-post-file', name: 'upfile', type: 'file', accept: 'image/gif,image/jpeg,image/png' }));
    row('Password',
      el('input', { id: 'wb-post-password', name: 'pwd', type: 'password', size: 8, value: identity.password }),
      document.createTextNode(' (for post deletion)'));
    const msgRow = el('tr');
    msgRow.append(el('td', { class: 'wb-postform-msg', colspan: 2 }, isReply ? `Reply to No.${engine.openThread}` : ''));
    table.append(msgRow);
    form.append(table);
    return form;
  }

  function renderRules() {
    const rules = el('div', { id: 'wb-rules' });
    const items = [
      'Supported file types are: GIF, JPG, PNG.',
      'Maximum file size allowed is 1024 KB.',
      'Images greater than 250x250 pixels will be thumbnailed.',
      'Read the rules and FAQ before posting.'
    ];
    for (const text of items) rules.append(el('div', { class: 'wb-rule-item' }, text));
    return rules;
  }

  function renderShell() {
    ensureStyles();
    let root = $('#wb-overlay');
    if (!root) {
      root = el('div', { id: 'wb-overlay' });
      (document.body || document.documentElement).append(root);
      // Force-hide 4chan's own content in case the stylesheet didn't load
      if (document.body) {
        for (const ch of document.body.children) {
          if (ch.id !== 'wb-overlay') ch.style.setProperty('display', 'none', 'important');
        }
      }
    }
    root.innerHTML = '';
    // Inline SVG filter: binary alpha threshold kills DirectWrite anti-aliasing,
    // giving text the crunchy bitmap look of old Windows GDI rendering.
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const filt = document.createElementNS(svgNS, 'filter');
    filt.setAttribute('id', 'wb-crunch');
    const ct = document.createElementNS(svgNS, 'feComponentTransfer');
    const fa = document.createElementNS(svgNS, 'feFuncA');
    fa.setAttribute('type', 'discrete');
    fa.setAttribute('tableValues', '0 1');
    ct.append(fa);
    filt.append(ct);
    svg.append(filt);
    root.append(svg);
    root.classList.toggle('wb-min', engine.barHidden);
    root.append(renderControlBar());
    root.append(el('div', { id: 'wb-restore', onclick: () => setBarHidden(false) }, 'show controls'));
    root.append(renderChrome());

    const title = el('div', { class: 'wb-boardtitle' },
      `/${engine.board}/ - ${BOARD_NAMES[engine.board] || engine.board.toUpperCase()}`);
    root.append(title);
    root.append(el('hr', { class: 'wb-titlerule' }));
    root.append(renderPostForm());
    root.append(renderRules());
    root.append(navBar('top'));

    if (engine.openThread) {
      root.append(el('div', { id: 'wb-thread-posts', class: 'wb-thread' }));
    } else if (engine.catalogView) {
      root.append(el('div', { id: 'wb-catalog', class: 'wb-catalog' }));
    } else {
      root.append(el('div', { id: 'wb-index', class: 'wb-index' }));
    }

    root.append(el('hr', { class: 'wb-titlerule' }));
    root.append(navBar('bottom'));
    updateClockDisplay();
    updateTitle();
  }

  function scrollOverlayToTop() {
    const root = $('#wb-overlay');
    if (!root) return;
    root.scrollTop = 0;
    root.scrollLeft = 0;
    requestAnimationFrame(() => {
      root.scrollTop = 0;
      root.scrollLeft = 0;
    });
  }

  // The [Return]/[Update]/[Top]/[Bottom] links 4chan put at the top and bottom
  // of every page. Top/Bottom scroll our overlay (the scroll container).
  function indexPageLinks() {
    const nodes = [];
    // Era-correct Previous/Next form buttons flanking the page list, as the
    // bottom of every real 4chan index page had.
    const btn = (label, page, enabled) => el('button', enabled
      ? { class: 'wb-pagebtn', onclick: (e) => { e.preventDefault(); goIndex(page); } }
      : { class: 'wb-pagebtn', disabled: 'disabled' }, label);
    nodes.push(btn('Previous', engine.indexPage - 1, engine.indexPage > 1), ' ');
    for (let i = 1; i <= CONFIG.indexPages; i++) {
      if (i === engine.indexPage) {
        nodes.push(el('span', { class: 'wb-pagecur' }, `[${i}]`));
      } else {
        nodes.push(el('a', {
          class: 'wb-navlink wb-pagelink',
          href: indexPath(i),
          onclick: (e) => { e.preventDefault(); goIndex(i); }
        }, `[${i}]`));
      }
      if (i < CONFIG.indexPages) nodes.push(' ');
    }
    nodes.push(' ', btn('Next', engine.indexPage + 1, engine.indexPage < CONFIG.indexPages));
    return nodes;
  }
  function navBar(position = 'top') {
    const overlay = () => $('#wb-overlay');
    const mk = (label, fn) => el('a', { class: 'wb-navlink', href: 'javascript:void(0)',
      onclick: (e) => { e.preventDefault(); fn(); } }, `[${label}]`);
    const top = () => { const o = overlay(); if (o) o.scrollTo({ top: 0 }); };
    const bottom = () => { const o = overlay(); if (o) o.scrollTo({ top: o.scrollHeight }); };
    const jump = position === 'bottom' ? mk('Top', top) : mk('Bottom', bottom);
    const bar = el('div', { class: 'wb-nav' });
    if (engine.openThread) {
      const update = el('a', { id: 'wb-update', class: 'wb-navlink', href: 'javascript:void(0)',
        onclick: (e) => { e.preventDefault(); revealThreadPosts(); } }, '[Update]');
      const auto = el('a', { id: 'wb-auto', class: 'wb-navlink', href: 'javascript:void(0)',
        onclick: (e) => {
          e.preventDefault();
          engine.autoUpdate = !engine.autoUpdate;
          saveSettings();
          auto.textContent = `[Auto-update: ${engine.autoUpdate ? 'on' : 'off'}]`;
          if (engine.autoUpdate) revealThreadPosts();
        } }, `[Auto-update: ${engine.autoUpdate ? 'on' : 'off'}]`);
      bar.append(mk('Return', backToIndex), ' ', mk('Index', goIndex), ' ', mk('Catalog', goCatalog), ' ', update, ' ', auto, ' ', jump);
    } else if (engine.catalogView) {
      bar.append(mk('Index', () => goIndex(1)), ' ', mk('Update', refreshCatalogData), ' ', jump);
    } else {
      bar.append(mk('Catalog', goCatalog), ' ', mk('Update', refreshIndexSnapshot), ' ', ...indexPageLinks(), ' ', jump);
    }
    return bar;
  }

  // ── Gentle background prefetch (stay ahead of the playhead) ─────────────────
  function enqueuePrefetch(num) {
    if (engine.threads.has(String(num)) || engine.prefetchQueue.includes(num)) return;
    engine.prefetchQueue.push(num);
    drainPrefetch();
  }
  async function drainPrefetch() {
    if (engine.prefetching) return;
    engine.prefetching = true;
    const worker = async () => {
      while (engine.prefetchQueue.length) {
        const num = engine.prefetchQueue.pop(); // newest-first: the threads on top fill in first
        const alreadyHydrated = engine.threads.has(String(num));
        await fetchThread(engine.board, num, { preferCache: true });
        if (!alreadyHydrated && CONFIG.prefetchDelayMs) await sleep(CONFIG.prefetchDelayMs);
      }
    };
    try {
      const n = Math.max(1, Math.min(CONFIG.prefetchConcurrency || 1, engine.prefetchQueue.length || 1));
      await Promise.all(Array.from({ length: n }, worker));
    } finally {
      engine.prefetching = false;
    }
    if (engine.prefetchQueue.length) drainPrefetch();
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  function parseURL() {
    const m = location.pathname.match(/^\/([a-z0-9]+)\/(?:(catalog)|thread\/(\d+)|(\d+))?\/?/i);
    return {
      board: m ? m[1] : null,
      catalog: !!(m && m[2]),
      thread: m && m[3] ? m[3] : null,
      page: m && m[4] ? clampIndexPage(m[4]) : 1
    };
  }

  async function boot(opts = {}) {
    resetIndexState();
    engine.shownPosts = new Set();
    const token = engine.catalogToken;

    // "Go" / an explicit date change starts a brand-new epoch; a plain refresh
    // must NOT — the persisted anchor keeps the clock synced to real time.
    if (opts.freshClock) clearAnchor();

    // Direct navigation or reload into a thread URL. 4chan 404s the long-dead
    // thread, but our script still runs on that page; we overlay the archived
    // thread and let it define the date + clock (the thread number is in the URL).
    if (engine.openThread) {
      // Seed an index entry beneath the thread so Back/Return returns to the
      // board instead of leaving 4chan.
      history.replaceState({ wb: 'index' }, '', `/${engine.board}/`);
      history.pushState({ wb: 'thread', num: engine.openThread }, '', `/${engine.board}/thread/${engine.openThread}`);
      renderShell();
      await openThread(engine.openThread, { startFromOP: true });
      return;
    }

    renderShell();
    const idx = $('#wb-index') || $('#wb-catalog');
    if (idx) idx.append(el('div', { id: 'wb-loading', class: 'wb-note' },
      `Loading /${engine.board}/ for ${CONFIG.date} — finding the day's threads…`));
    ensureAnchor();
    startTimer();

    const cachedOps = cachedCatalogOps(engine.board, CONFIG.date);
    if (cachedOps.length) {
      engine.ops = cachedOps;
      loadCachedThreadSummariesIntoMemory(engine.board, engine.ops);
      loadCachedThreadsIntoMemory(engine.board, engine.ops);
      refreshCurrentBoardSnapshot();
    }

    await loadBoardOps(token);
  }

  // Enumerate the board and keep retrying on failure — rate limits lift and
  // outages pass, so the index must never die on its loading note. Stops
  // only when the user navigates (token change) or opens a thread.
  async function loadBoardOps(token, attempt = 0) {
    // Live progress in the loading note: how many threads are in, how full
    // the board is, and which day the backward scan is on — so a slow cold
    // load reads as work happening instead of a dead page.
    const onProgress = (partialOps, meta = {}) => {
      if (token !== engine.catalogToken || engine.openThread) return;
      engine.ops = partialOps;
      refreshCurrentBoardSnapshot();
      const note = $('#wb-loading');
      if (!note) return;
      const bits = [`Loading /${engine.board}/ for ${CONFIG.date}`];
      bits.push(`${partialOps.length} thread${partialOps.length === 1 ? '' : 's'} found`);
      if (typeof meta.visibleAtEnd === 'number' && meta.target) {
        bits.push(`${Math.min(meta.visibleAtEnd, meta.target)}/${meta.target} board slots filled`);
      }
      if (meta.scanDay && meta.scanOffset > 0) {
        bits.push(`scanning ${meta.scanDay} for older active threads (day ${meta.scanOffset + 1} of up to ${meta.maxDays})`);
      }
      note.textContent = bits.join(' — ') + '…';
    };
    let ops = null;
    try {
      ops = await enumerateCatalogCandidates(engine.board, CONFIG.date, { atClock: engine.clock, onProgress });
    } catch (e) {
      cacheDebug('warn', 'board enumeration failed', { board: engine.board, date: CONFIG.date, attempt, error: String(e && e.message || e) });
    }
    if (token !== engine.catalogToken) return;

    if (ops && ops.length) {
      const note = $('#wb-loading');
      if (note) note.remove(); // enumeration done — the sync note takes over
      engine.ops = ops;
      loadCachedThreadSummariesIntoMemory(engine.board, engine.ops);
      loadCachedThreadsIntoMemory(engine.board, engine.ops);
      refreshCurrentBoardSnapshot();
      hydrateCatalog(engine.board, engine.ops);
      return;
    }

    const wait = Math.min(120000, 10000 * Math.pow(1.6, attempt)) + Math.floor(Math.random() * 5000);
    const host = $('#wb-index') || $('#wb-catalog');
    if (host) {
      let note = $('#wb-loading', host);
      if (!note) { note = el('div', { id: 'wb-loading', class: 'wb-note' }); host.append(note); }
      note.textContent = `No threads loaded for /${engine.board}/ on ${CONFIG.date} yet — ` +
        `the archives may be rate limiting or the board may have nothing archived that day. ` +
        `Retrying in ${Math.round(wait / 1000)}s…`;
    }
    setTimeout(() => {
      if (token === engine.catalogToken && !engine.openThread) loadBoardOps(token, attempt + 1);
    }, wait);
  }

  function init() {
    ensureStyles(); // in case the document-start injection ran before <head> existed
    try { initStorageEstimate(); } catch (e) { /* storage may be unreadable */ }
    try {
      for (const k of cacheKeys()) { if (k.startsWith('thr:')) cacheDelete(k); }
    } catch (e) { /* best-effort cleanup */ }
    try { pruneStorage(null); } catch (e) { /* fallback prune */ }

    // Grab 4chan's genuine rotating banner before the page is hidden, so we can
    // show the real thing (with its own shuffle-on-click) inside our chrome.
    engine.realBanner = document.querySelector('#bannerCnt');

    const saved = cacheGet('settings');
    if (saved) {
      engine.board = saved.board || engine.board;
      CONFIG.date = saved.date || CONFIG.date;
      CONFIG.startTime = saved.startTime || CONFIG.startTime;
      engine.speed = saved.speed || engine.speed;
      engine.barHidden = !!saved.barHidden;
      if (typeof saved.autoUpdate === 'boolean') engine.autoUpdate = saved.autoUpdate;
      if (typeof saved.mediaDebug === 'boolean') CONFIG.mediaDebug = saved.mediaDebug;
      if (typeof saved.cacheDebug === 'boolean') CONFIG.cacheDebug = saved.cacheDebug;
      engine.catalogSort = normCatalogSort(saved.catalogSort);
      applyTheme(saved.theme || saved.colors);
      applyDesign(saved.design);
    }

    // Reflect the persisted clock epoch in the speed/pause controls before the
    // first render, so the bar matches the clock we're about to resume.
    const savedAnchor = loadAnchor();
    if (savedAnchor) {
      engine.speed = savedAnchor.speed || engine.speed;
      engine.paused = !!savedAnchor.paused;
    }

    const { board, catalog, thread, page } = parseURL();
    if (board) engine.board = board;
    engine.openThread = thread;
    engine.catalogView = !!catalog && !thread;
    engine.indexPage = page || 1;
    updateTitle(); // replace the 404 tab title as early as possible

    // Browser Back/Forward: re-render whichever view the URL now points at,
    // without pushing history again.
    window.addEventListener('popstate', () => {
      const cur = parseURL();
      if (cur.board) engine.board = cur.board;
      if (cur.thread) { engine.openThread = cur.thread; engine.catalogView = false; openThread(cur.thread); }
      else if (cur.catalog) showCatalogView({ refresh: true });
      else showIndexView({ page: cur.page || 1, refresh: true });
    });

    GM_registerMenuCommand('Replay this board on a different date', () => {
      const d = prompt('Replay date (YYYY-MM-DD):', CONFIG.date);
      if (d) { CONFIG.date = d; saveSettings(); boot({ freshClock: true }); }
    });
    GM_registerMenuCommand(`${CONFIG.mediaDebug ? 'Disable' : 'Enable'} image fetch diagnostics`, () => {
      CONFIG.mediaDebug = !CONFIG.mediaDebug;
      saveSettings();
      if (CONFIG.mediaDebug) {
        mediaDebug('debug', 'diagnostics enabled', {
          note: 'Image fetch diagnostics are now logging to the console and window.oldchanMediaLog.'
        });
      } else {
        try { console.info('[oldchan media] diagnostics disabled'); } catch (e) { /* console unavailable */ }
      }
    });
    GM_registerMenuCommand('Dump image fetch diagnostics', () => {
      try {
        console.table(_mediaDebugLog.map((e) => ({
          ts: e.ts,
          level: e.level,
          msg: e.msg,
          source: e.data && e.data.source || '',
          status: e.data && e.data.status || '',
          type: e.data && e.data.type || '',
          size: e.data && e.data.size || '',
          reason: e.data && e.data.reason || '',
          url: e.data && e.data.url || ''
        })));
        console.log('[oldchan media] raw diagnostics', _mediaDebugLog);
      } catch (e) { /* console unavailable */ }
    });
    GM_registerMenuCommand('Clear image fetch diagnostics', () => {
      _mediaDebugLog.length = 0;
      try { console.info('[oldchan media] diagnostics cleared'); } catch (e) { /* console unavailable */ }
    });
    GM_registerMenuCommand('Clear cached image fetches', () => {
      let deleted = 0;
      for (const k of cacheKeys()) {
        if (/^media:/.test(k) && cacheDelete(k)) deleted++;
      }
      _blobCache.clear();
      _postBlobCache.clear();
      _postBlobResultCache.clear();
      _postMediaCache.clear();
      _searchMediaCache.clear();
      _iaMlpIndex = null;
      _iaMlpIndexPromise = null;
      if (mediaCacheAvailable() || archiveOrgIndexCacheAvailable()) {
        _mediaCacheHandle = null; // stale after delete — reopen on next use
        Promise.all([
          mediaCacheAvailable() ? caches.delete(MEDIA_CACHE_NAME) : Promise.resolve(false),
          archiveOrgIndexCacheAvailable() ? caches.delete(IA_MLP_INDEX_CACHE_NAME) : Promise.resolve(false)
        ]).then(([mediaOk, indexOk]) => {
          try { console.info(`[oldchan media] cleared ${deleted} image resolution entries; persistent media cache deleted: ${mediaOk}; archive.org md5 index cache deleted: ${indexOk}`); } catch (e) { /* console unavailable */ }
        });
      } else {
        try { console.info(`[oldchan media] cleared ${deleted} image resolution entries`); } catch (e) { /* console unavailable */ }
      }
    });
    GM_registerMenuCommand('Clear cached threads', () => {
      if ('caches' in window && window.caches) {
        _threadCacheHandle = null; // stale after delete — reopen on next use
        caches.delete(THREAD_CACHE_NAME).then((ok) => {
          try { console.info(`[oldchan] persistent thread cache deleted: ${ok}`); } catch (e) { /* console unavailable */ }
        });
      }
    });

    // The clock is a pure function of wall time, but setInterval is throttled or
    // suspended in background tabs (and the OS may sleep). Recompute from the
    // anchor the instant we're visible/focused again, and when restored from the
    // back-forward cache — so the displayed time is never stale on return.
    const resyncClock = () => { if (engine.anchor) tick(); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resyncClock(); });
    window.addEventListener('focus', resyncClock);
    window.addEventListener('pageshow', resyncClock);

    boot();
  }

  // run after DOM exists, but we overlay so we don't depend on 4chan's content
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ── Era-correct styling (Yotsuba B, the worksafe theme) ─────────────────────
  function getCSS() { return `
    /* Yotsuba B (worksafe blue) — the default palette. */
    html.wb-active {
      --wb-page-bg:#EEF2FF; --wb-text:#000000; --wb-link:#34345C; --wb-link-hover:#DD0000;
      --wb-rule:#B7C5D9; --wb-title:#AF0A0F; --wb-reply-bg:#D6DAF0; --wb-reply-border:#B7C5D9;
      --wb-name:#117743; --wb-trip:#117743; --wb-subject:#0F0C5D; --wb-no:#000000;
      --wb-quote:#789922; --wb-quotelink:#DD0000; --wb-hl-bg:#D6BAD0; --wb-hl-border:#BA9DBF;
      --wb-bar-bg:#D6DAF0; --wb-nav:#8899AA; --wb-dim:#707070; --wb-thumb-bg:#EEF2FF; --wb-arrows:#B7C5D9;
      --wb-form-label:#98ABD9;
    }
    /* Tomorrow — dark theme (real values from tomorrow.css). */
    html.wb-active.wb-colors-tomorrow {
      --wb-page-bg:#1d1f21; --wb-text:#c5c8c6; --wb-link:#81a2be; --wb-link-hover:#5F89AC;
      --wb-rule:#282a2e; --wb-title:#c5c8c6; --wb-reply-bg:#282a2e; --wb-reply-border:#282a2e;
      --wb-name:#c5c8c6; --wb-trip:#c5c8c6; --wb-subject:#b294bb; --wb-no:#c5c8c6;
      --wb-quote:#b5bd68; --wb-quotelink:#5F89AC; --wb-hl-bg:#1D1D21; --wb-hl-border:#111111;
      --wb-bar-bg:#282a2e; --wb-nav:#c5c8c6; --wb-dim:#707070; --wb-thumb-bg:#1d1f21; --wb-arrows:#c5c8c6;
      --wb-form-label:#383a3e;
    }
    /* Yotsuba — the original red/cream palette (genuine values from archived yotsuba.9.css). */
    html.wb-active.wb-colors-yotsuba {
      --wb-page-bg:#FFFFEE; --wb-text:#800000; --wb-link:#0000EE; --wb-link-hover:#DD0000;
      --wb-rule:#D9BFB7; --wb-title:#800000; --wb-reply-bg:#F0E0D6; --wb-reply-border:#D9BFB7;
      --wb-name:#117743; --wb-trip:#228854; --wb-subject:#CC1105; --wb-no:#800000;
      --wb-quote:#789922; --wb-quotelink:#000080; --wb-hl-bg:#F0C0B0; --wb-hl-border:#D99F91;
      --wb-bar-bg:#F0E0D6; --wb-nav:#BB8866; --wb-dim:#707070; --wb-thumb-bg:#FFFFEE; --wb-arrows:#D9BFB7;
      --wb-form-label:#EEAA88;
    }
    /* ═══ 2005 design ═══════════════════════════════════════════════════ */
    /* Post form */
    #wb-postform { display:block; text-align:center; margin:4px 0; }
    .wb-postform-table { margin:0 auto; border-spacing:1px; }
    .wb-postform-label { background:var(--wb-form-label); color:var(--wb-text); font-weight:700;
      padding:1px 5px; font-size:10pt; text-align:left; }
    .wb-postform-input { padding:1px; }
    .wb-postform-input input[type="text"],
    .wb-postform-input input[type="password"],
    .wb-postform-input textarea { border:1px solid #aaa; font-family:arial,helvetica,sans-serif; font-size:10pt; }
    .wb-postform-input input:focus,
    .wb-postform-input textarea:focus { border-color:#ea8; outline:none; }
    .wb-postform-msg { text-align:center; color:var(--wb-dim); font-size:9pt; padding:2px; }
    .wb-postform-error { color:#DD0000; font-weight:bold; }
    /* Rules section */
    #wb-rules { display:none; }
    html.wb-active.wb-design-2005 #wb-rules {
      display:block; text-align:center; margin:4px 0 2px; font-size:9pt; color:var(--wb-text); }
    .wb-rule-item::before { content:"\\2666  "; }
    .wb-rule-item { margin:1px 0; }
    /* Embossed XP-style form controls */
    html.wb-active.wb-design-2005 button,
    html.wb-active.wb-design-2005 #wb-bar button,
    html.wb-active.wb-design-2005 .wb-postform-input button {
      background:#ece9d8; border:2px outset #ece9d8; color:#000; padding:1px 8px; cursor:pointer; font-size:11px; }
    html.wb-active.wb-design-2005 button:active { border-style:inset; }
    html.wb-active.wb-design-2005 select,
    html.wb-active.wb-design-2005 #wb-bar select {
      background:#ece9d8; border:2px outset #ece9d8; color:#000; font-size:11px; padding:0 2px; }
    html.wb-active.wb-design-2005 input[type="text"],
    html.wb-active.wb-design-2005 input[type="date"],
    html.wb-active.wb-design-2005 input[type="time"],
    html.wb-active.wb-design-2005 input[type="password"],
    html.wb-active.wb-design-2005 textarea { border:2px inset #ece9d8; background:#fff; }
    html.wb-active.wb-design-2005 input[type="file"]::file-selector-button {
      background:#ece9d8; border:2px outset #ece9d8; color:#000; padding:1px 6px; cursor:pointer;
      font-size:11px; font-family:arial,helvetica,sans-serif; }
    html.wb-active.wb-design-2005 input[type="file"]::file-selector-button:active { border-style:inset; }
    /* Board title stays Tahoma (already default) */
    html.wb-active.wb-design-2005 .wb-boardtitle { font-family:Tahoma,Geneva,sans-serif; }
    /* Reply link is plain (no underline) in 2005 */
    html.wb-active.wb-design-2005 .wb-replylink { color:var(--wb-link); text-decoration:none; }
    html.wb-active.wb-design-2005 .wb-replylink:hover { color:var(--wb-link-hover); }
    html.wb-active, html.wb-active body { margin:0 !important; padding:0 !important; background:var(--wb-page-bg) !important; overflow:hidden !important; }
    html.wb-active body > *:not(#wb-overlay) { display:none !important; }
    #wb-overlay {
      position:fixed; inset:0; z-index:2147483646; overflow:auto;
      background:var(--wb-page-bg); color:var(--wb-text); text-align:left;
      font-family: arial, helvetica, sans-serif; font-size:10pt;
      /* kill anti-aliasing for the crunchy old-monitor look (effective on
         WebKit/Blink; on Windows the OS partly governs this) */
      -webkit-font-smoothing:none; font-smooth:never; text-rendering:optimizeSpeed;
    }
    /* Binary alpha threshold: snaps every text pixel to fully opaque or
       transparent, replicating old Windows GDI bitmap rendering. Applied to
       text containers only so images stay smooth. */
    .wb-postinfo, .wb-comment, .wb-fileinfo, .wb-omitted,
    .wb-nav, .wb-boardtitle, .wb-note,
    #wb-bar, #wb-boardnav, #wb-postform, #wb-rules,
    .wb-catalog-meta, .wb-catalog-title, .wb-catalog-text {
      filter: url(#wb-crunch);
    }
    #wb-overlay a, #wb-overlay a:visited { color:var(--wb-link); text-decoration:none; }
    #wb-overlay a:hover { color:var(--wb-link-hover); }
    #wb-overlay hr { border:none; border-top:1px solid var(--wb-rule); height:0; }

    /* thin utility strip — 4chan had no such bar, so keep it quiet and plain */
    #wb-bar {
      position:sticky; top:0; z-index:5; background:var(--wb-bar-bg); border-bottom:2px solid var(--wb-rule);
      padding:3px 5px; font-size:12px; color:var(--wb-text); display:flex; gap:8px; align-items:center; flex-wrap:wrap;
    }
    #wb-bar label { color:var(--wb-text); }
    #wb-bar input, #wb-bar select, #wb-bar button { font-size:12px; font-family:arial,helvetica,sans-serif; }
    #wb-bar #wb-clock { margin-left:auto; font-weight:bold; color:var(--wb-text); }
    #wb-bar #wb-ratelimit { color:#c00; font-weight:bold; }
    #wb-bar #wb-ratelimit:empty { display:none; }

    /* real 4chan top chrome: board list + nav links + relocated banner */
    #wb-chrome { padding:2px 0 0; }
    #wb-boardnav { font-size:9pt; line-height:1.5; padding:2px 5px 0; color:var(--wb-nav); overflow:hidden; }
    #wb-boardnav .wb-boardlink { color:var(--wb-link); text-decoration:none; }
    #wb-boardnav .wb-boardlink:hover { color:var(--wb-link-hover); text-decoration:underline; }
    #wb-navright { float:right; white-space:nowrap; }
    #wb-banner { text-align:center; margin:5px auto 0; clear:both; }
    #wb-banner #bannerCnt, #wb-banner .wb-title-banner { display:inline-block !important; cursor:pointer; }
    #wb-banner img { max-width:100%; height:auto; }

    .wb-boardtitle {
      text-align:center; font-family:Tahoma, Geneva, sans-serif; font-size:28px; font-weight:bold;
      color:var(--wb-title); letter-spacing:-2px; padding:6px 0 0;
    }
    .wb-titlerule { border:none; border-top:1px solid var(--wb-rule); margin:6px 5px; }
    .wb-nav { padding:2px 5px; font-size:9pt; color:var(--wb-nav); }
    .wb-navlink { color:var(--wb-link); text-decoration:underline; margin-right:6px; }
    .wb-navlink:hover { color:var(--wb-link-hover); }
    .wb-pagecur { color:var(--wb-text); font-weight:bold; margin-right:4px; }
    .wb-pagelink { margin-right:3px; }
    #wb-overlay.wb-min #wb-bar { display:none; }
    #wb-restore { display:none; position:fixed; top:4px; right:6px; z-index:7;
      background:var(--wb-bar-bg); border:1px solid var(--wb-rule); color:var(--wb-link); font-size:12px; padding:1px 6px; cursor:pointer; }
    #wb-overlay.wb-min #wb-restore { display:block; }

    .wb-index, .wb-thread { padding:4px 5px 8px; }
    .wb-threadcard { margin:0 0 6px; }
    /* Catalog: genuine Yotsuba Catalog (desuwa) layout, painted in 4chan theme colors.
       Centered inline-block grid, bordered thumbnails, no per-card boxes. */
    .wb-catalog {
      box-sizing:border-box; width:100%; margin:0 auto;
      padding:10px 4px 8px; text-align:center; position:relative;
      font:11px Arial, sans-serif; line-height:1.2;
    }
    .wb-catalog .wb-note { display:block; }
    .wb-catalog-card {
      display:inline-block; vertical-align:top; text-align:center;
      width:152px; margin:0 2px 7px; padding:2px 0 3px;
      word-wrap:break-word; overflow:hidden; max-height:300px; box-sizing:border-box;
      cursor:pointer;
    }
    .wb-catalog-thumb { display:inline-block; line-height:0; margin:0 0 2px; }
    .wb-catalog-thumb img {
      max-width:150px; max-height:150px; cursor:pointer; vertical-align:bottom;
      border:0; border-radius:0; box-shadow:none;
    }
    .wb-catalog-noimage {
      display:inline-flex; align-items:center; justify-content:center;
      width:150px; height:110px; background:var(--wb-thumb-bg);
      border:1px solid var(--wb-reply-border); margin:0 0 2px;
    }
    .wb-catalog-noimage::before { content:"No image"; color:var(--wb-dim); font-size:11px; }
    .wb-catalog-missing img, .wb-missing-placeholder { opacity:.82; filter:saturate(.85); }
    /* A little pixel hourglass: choppy old-Windows-cursor flip with sand that
       drops in discrete steps. The frame flips 180 each half-cycle; the two
       triangles (top drains, bottom fills) are the sand. */
    .wb-media-loader {
      display:inline-block; position:relative; width:9px; height:13px; margin-left:4px;
      color:var(--wb-dim); vertical-align:-2px; opacity:.8; box-sizing:border-box;
      border-top:1px solid currentColor; border-bottom:1px solid currentColor;
      animation:wb-hg-flip 1.3s linear infinite;
    }
    .wb-media-loader::before, .wb-media-loader::after {
      content:""; position:absolute; left:0; right:0; width:0; height:0; margin:auto;
      border-left:3.5px solid transparent; border-right:3.5px solid transparent;
    }
    .wb-media-loader::before { top:0; border-top:5px solid currentColor; animation:wb-hg-fill .65s steps(4) infinite alternate; }
    .wb-media-loader::after  { bottom:0; border-bottom:5px solid currentColor; animation:wb-hg-drain .65s steps(4) infinite alternate; }
    .wb-catalog-loader { width:10px; height:14px; margin-left:0; }
    /* The flip: hold upright, snap through an edge-on frame to 180, hold, snap back. */
    @keyframes wb-hg-flip {
      0%, 42%  { transform:rotate(0deg); }
      46%      { transform:rotate(90deg); }
      50%, 92% { transform:rotate(180deg); }
      96%      { transform:rotate(270deg); }
      100%     { transform:rotate(360deg); }
    }
    @keyframes wb-hg-drain { from { border-top-width:5px; }  to { border-top-width:0; } }
    @keyframes wb-hg-fill  { from { border-bottom-width:0; } to { border-bottom-width:5px; } }
    @media (prefers-reduced-motion: reduce) {
      .wb-media-loader, .wb-media-loader::before, .wb-media-loader::after { animation:none; }
    }
    .wb-catalog-meta { color:var(--wb-text); font-size:10px; line-height:11px; margin:1px 0; }
    .wb-catalog-open { display:none; }
    .wb-catalog-title { color:var(--wb-subject); font-weight:bold; font-size:11px; overflow-wrap:anywhere; display:block; }
    .wb-catalog-text { color:var(--wb-text); font-size:11px; overflow-wrap:anywhere; display:block; line-height:13px; margin-top:1px; }

    /* OP: no box, just contains its floated image (div.post{overflow:hidden}). */
    .wb-op { display:block; overflow:hidden; margin:4px 0; clear:both; }
    /* Reply: the light-purple box that shrink-wraps content (div.reply{display:table}). */
    .wb-postrow { display:block; clear:both; margin:4px 0; }
    .wb-arrows { float:left; margin:0 3px 0 2px; color:var(--wb-arrows); line-height:1.25; }
    .wb-reply {
      display:table; padding:2px; margin:0;
      background:var(--wb-reply-bg); border:1px solid var(--wb-reply-border); border-left:none; border-top:none;
    }
    .wb-reply:target, .wb-reply.wb-highlight {
      background:var(--wb-hl-bg); border:1px solid var(--wb-hl-border); border-left:none; border-top:none;
    }
    .wb-op.wb-highlight { background:var(--wb-hl-bg); }
    .wb-postinfo { display:block; width:100%; line-height:1.25; }
    .wb-name { color:var(--wb-name); font-weight:bold; }
    .wb-trip { color:var(--wb-trip); font-weight:normal; }
    .wb-subject { color:var(--wb-subject); font-weight:bold; }
    .wb-no { color:var(--wb-no); }
    .wb-backlinks { font-size:x-small; }
    .wb-backlink { margin-left:0; }
    .wb-replylink { color:var(--wb-link); text-decoration:underline; margin-left:4px; }
    /* The 40px blockquote indent is the browser default 4chan relied on. */
    .wb-comment { display:block; margin:1em 40px; line-height:1.25; word-wrap:break-word; overflow-wrap:break-word; }
    .wb-quote { color:var(--wb-quote); }
    .wb-spoiler { background:#000 !important; }
    .wb-spoiler, .wb-spoiler * { color:#000 !important; }
    .wb-spoiler:hover, .wb-spoiler:hover * { color:#fff !important; }
    .wb-quotelink { color:var(--wb-quotelink); text-decoration:underline; }
    .wb-omitted { display:block; color:var(--wb-dim); margin:2px 0 2px 20px; }
    .wb-threadicon { vertical-align:text-bottom; margin:0 1px; }
    .wb-pagebtn { font-size:11px; }
    .wb-previews { }
    .wb-previewrow { margin:0; }
    .wb-file { display:block; }
    .wb-fileinfo { color:var(--wb-text); margin-right:10px; }
    .wb-reply .wb-fileinfo { margin-left:20px; }
    .wb-fileinfo.wb-media-unavailable::after { content:" [image unavailable]"; color:var(--wb-dim); }
    .wb-thumb { float:left; margin:3px 20px 5px 20px; cursor:pointer; border:none; position:relative; z-index:1; }
    .wb-thumb.wb-missing-placeholder { cursor:default; }
    .wb-op .wb-thumb { max-width:250px; max-height:250px; }
    .wb-reply .wb-thumb { max-width:125px; max-height:125px; }
    .wb-thumb.wb-expanded { max-width:90vw; max-height:none; }
    .wb-thumb.wb-expanded.wb-thumb-fallback { width:min(420px, 90vw); height:auto; image-rendering:auto; }
    .wb-threadcard hr, .wb-thread hr { clear:both; border:none; border-top:1px solid var(--wb-rule); margin:4px 0; }
    .wb-note { padding:8px 4px; color:var(--wb-dim); }
  `; }
})();
