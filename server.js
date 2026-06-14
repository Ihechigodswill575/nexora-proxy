// ═══════════════════════════════════════════════
// NEXORA PROXY SERVER — with full session/cookie handling
// Implements the exact flow from the SDK:
// 1. Hit APP_INFO_PATH to get session cookies
// 2. Pass cookies + Referer on every stream request
// ═══════════════════════════════════════════════

const express = require("express");
const axios   = require("axios");
const cors    = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Mirror hosts from SDK constants.ts ──
const MIRROR_HOSTS = [
  "h5.aoneroom.com",
  "movieboxapp.in",
  "moviebox.pk",
  "moviebox.ph",
  "moviebox.id",
  "v.moviebox.ph",
  "netnaija.video"
];

// ── Default headers from SDK constants.ts ──
const DEFAULT_HEADERS = {
  "Accept":           "application/json",
  "Accept-Language":  "en-US,en;q=0.5",
  "X-Client-Info":    '{"timezone":"Africa/Nairobi"}',
  "User-Agent":       "moviebox-js-sdk/preview",
  "Content-Type":     "application/json"
};

// ── Paths from SDK ──
const APP_INFO_PATH  = "/wefeed-h5-bff/app/get-latest-app-pkgs";
const STREAM_PATH    = "/wefeed-h5-bff/web/subject/play";
const DOWNLOAD_PATH  = "/wefeed-h5-bff/web/subject/download";
const SEARCH_PATH    = "/wefeed-h5-bff/web/subject/search";

// ═══════════════════════════════════════════════
// SESSION — one per mirror, cached with cookies
// Mirrors the SDK's MovieboxSession + cookieJar
// ═══════════════════════════════════════════════
class Session {
  constructor(host) {
    this.host    = host;
    this.baseUrl = `https://${host}`;
    this.cookies = new Map(); // cookieJar
    this.initialized = false;
  }

  // Extract and store Set-Cookie headers (mirrors storeResponseCookies)
  storeCookies(headers) {
    const raw = headers["set-cookie"];
    if (!raw) return;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const cookie of list) {
      const [pair] = cookie.split(";");
      if (!pair) continue;
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) continue;
      const name  = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      if (name && value) this.cookies.set(name, value);
      else if (name)     this.cookies.delete(name);
    }
  }

  // Serialize cookie jar (mirrors serializeCookies)
  cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k,v]) => `${k}=${v}`).join("; ");
  }

  // Hit APP_INFO_PATH to initialize session cookies (mirrors ensureSessionCookies)
  async init() {
    if (this.initialized) return;
    try {
      const res = await axios.get(
        `${this.baseUrl}${APP_INFO_PATH}?app_name=moviebox`,
        {
          headers: { ...DEFAULT_HEADERS, Cookie: this.cookieHeader() },
          timeout: 8000,
          validateStatus: () => true // don't throw on non-2xx
        }
      );
      this.storeCookies(res.headers);
      this.initialized = true;
      console.log(`[Session:${this.host}] Initialized, cookies: ${this.cookies.size}`);
    } catch(e) {
      console.warn(`[Session:${this.host}] Init failed:`, e.message);
      this.initialized = true; // mark done even on fail, try anyway
    }
  }

  // Make a GET request with cookies + Referer
  async get(path, params = {}, extraHeaders = {}) {
    await this.init();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const headers = {
      ...DEFAULT_HEADERS,
      ...extraHeaders,
      Cookie: this.cookieHeader()
    };

    const res = await axios.get(url.toString(), {
      headers,
      timeout: 10000,
      validateStatus: () => true
    });

    this.storeCookies(res.headers);

    if (res.status === 403 || res.status === 451) {
      throw new Error(`GeoBlocked: ${res.status} from ${this.host}`);
    }
    if (!res.status.toString().startsWith('2')) {
      throw new Error(`HTTP ${res.status} from ${this.host}`);
    }

    // Unwrap envelope { code: 0, message: "ok", data: {...} }
    const json = res.data;
    if (json && typeof json.code === 'number') {
      if (json.code === 0 && json.data !== undefined) return json.data;
      throw new Error(`API error ${json.code}: ${json.message}`);
    }
    return json;
  }

  // POST with cookies
  async post(path, body = {}) {
    await this.init();
    const headers = {
      ...DEFAULT_HEADERS,
      Cookie: this.cookieHeader()
    };

    const res = await axios.post(
      `${this.baseUrl}${path}`,
      body,
      { headers, timeout: 10000, validateStatus: () => true }
    );

    this.storeCookies(res.headers);

    if (!res.status.toString().startsWith('2')) {
      throw new Error(`HTTP ${res.status} from ${this.host}`);
    }

    const json = res.data;
    if (json && typeof json.code === 'number') {
      if (json.code === 0 && json.data !== undefined) return json.data;
      throw new Error(`API error ${json.code}: ${json.message}`);
    }
    return json;
  }
}

// ── One session per mirror, persistent across requests ──
const sessions = MIRROR_HOSTS.map(h => new Session(h));
let currentIdx = 0;

// Try each mirror in order, rotate on failure
async function withMirror(fn) {
  const start = currentIdx;
  for (let i = 0; i < sessions.length; i++) {
    const idx = (start + i) % sessions.length;
    const session = sessions[idx];
    try {
      const result = await fn(session);
      currentIdx = idx; // stick to working mirror
      return result;
    } catch(e) {
      console.warn(`[Mirror ${session.host}] failed:`, e.message);
    }
  }
  throw new Error("All mirrors exhausted");
}

// ═══════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Nexora Proxy", mirrors: sessions.map(s=>s.host) });
});

// ── SEARCH ──────────────────────────────────────
app.get("/search", async (req, res) => {
  const { q, type = "all", page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: "Missing q" });
  const typeMap = { all: 0, movie: 1, tv: 2 };
  try {
    const data = await withMirror(s => s.post(SEARCH_PATH, {
      keyword: q, page: parseInt(page), perPage: 24,
      subjectType: typeMap[type] ?? 0
    }));
    res.json({
      results: (data.items || []).map(item => ({
        id:          item.subjectId,
        title:       item.title,
        type:        item.subjectType === 1 ? "movie" : item.subjectType === 2 ? "tv" : "other",
        description: item.description || "",
        releaseYear: item.releaseDate ? parseInt(item.releaseDate.slice(0,4)) : null,
        rating:      parseFloat(item.imdbRatingValue) || null,
        posterUrl:   item.cover?.url || item.image?.url || null,
        detailPath:  item.detailPath || null,
        hasResource: Boolean(item.hasResource)
      })),
      hasMore:  data.pager?.hasMore ?? false,
      nextPage: data.pager?.hasMore ? parseInt(data.pager.nextPage) : null,
      total:    parseInt(data.pager?.totalCount || 0)
    });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── FIND BEST MATCH ──────────────────────────────
app.get("/find", async (req, res) => {
  const { title, year, type = "movie" } = req.query;
  if (!title) return res.status(400).json({ error: "Missing title" });
  const typeMap = { movie: 1, tv: 2 };
  try {
    const data = await withMirror(s => s.post(SEARCH_PATH, {
      keyword: title, page: 1, perPage: 10,
      subjectType: typeMap[type] ?? 0
    }));
    const items = (data.items || []).map(item => ({
      id:          item.subjectId,
      title:       item.title,
      type:        item.subjectType === 1 ? "movie" : "tv",
      releaseYear: item.releaseDate ? parseInt(item.releaseDate.slice(0,4)) : null,
      posterUrl:   item.cover?.url || item.image?.url || null,
      detailPath:  item.detailPath || null,
      hasResource: Boolean(item.hasResource)
    }));
    // Score matches
    const scored = items.map(item => {
      let score = 0;
      const t1 = item.title.toLowerCase().trim();
      const t2 = String(title).toLowerCase().trim();
      if (t1 === t2) score += 100;
      else if (t1.includes(t2) || t2.includes(t1)) score += 60;
      else {
        const w1 = new Set(t1.split(/\s+/));
        score += t2.split(/\s+/).filter(w => w1.has(w)).length * 15;
      }
      if (year && item.releaseYear) {
        if (Math.abs(item.releaseYear - parseInt(year)) === 0) score += 30;
        else if (Math.abs(item.releaseYear - parseInt(year)) <= 1) score += 10;
      }
      if (item.hasResource) score += 20;
      return { ...item, score };
    }).sort((a,b) => b.score - a.score);

    const best = scored[0];
    res.json({ found: !!(best && best.score >= 20), item: best || null });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── STREAM — with cookies + Referer ─────────────
// This is the key fix — mirrors stream.ts fetchStream()
app.get("/stream", async (req, res) => {
  const { id, detailPath, season = 0, episode = 0 } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    const data = await withMirror(async session => {
      // Build Referer exactly like the SDK does:
      // session.buildUrl(`/movies/${slug}`)
      const slug = detailPath
        ? String(detailPath).split("/").filter(Boolean).pop()
        : id;
      const referer = `${session.baseUrl}/movies/${slug}`;

      return session.get(
        STREAM_PATH,
        { subjectId: id, se: parseInt(season), ep: parseInt(episode) },
        { Referer: referer }  // ← THE KEY — this is what was missing
      );
    });

    const streams = (data.streams || [])
      .map(s => ({
        id:         s.id,
        quality:    `${s.resolutions}p`,
        resolution: parseInt(s.resolutions) || 0,
        url:        s.url,
        format:     s.format || "mp4",
        size:       parseInt(s.size) || 0
      }))
      .sort((a, b) => a.resolution - b.resolution);

    res.json({
      streams,
      best:        streams[streams.length - 1] || null,
      hasResource: data.hasResource || false,
      freeNum:     data.freeNum || 0
    });
  } catch(e) {
    console.error("[/stream]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── DOWNLOAD ─────────────────────────────────────
app.get("/download", async (req, res) => {
  const { id, detailPath, season = 0, episode = 0 } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });
  try {
    const data = await withMirror(async session => {
      const slug = detailPath
        ? String(detailPath).split("/").filter(Boolean).pop()
        : id;
      const referer = `${session.baseUrl}/movies/${slug}`;
      return session.get(
        DOWNLOAD_PATH,
        { subjectId: id, se: parseInt(season), ep: parseInt(episode) },
        { Referer: referer }
      );
    });

    const downloads = (data.downloads || [])
      .map(d => ({ id: d.id, quality: `${d.resolution}p`, resolution: d.resolution, url: d.url, size: d.size }))
      .sort((a,b) => a.resolution - b.resolution);
    const captions = (data.captions || [])
      .map(c => ({ id: c.id, language: c.lanName, code: c.lan, url: c.url }));

    res.json({ downloads, captions, hasResource: data.hasResource || false });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── STREAM PROXY — pipes video stream with cookies ──
// Needed because the video URL itself also requires the session cookie
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const session = sessions[currentIdx] || sessions[0];
    const range   = req.headers.range;
    const headers = {
      ...DEFAULT_HEADERS,
      Cookie: session.cookieHeader(),
      Referer: session.baseUrl
    };
    if (range) headers.Range = range;

    const upstream = await axios({
      method:       "GET",
      url:          decodeURIComponent(url),
      headers,
      responseType: "stream",
      timeout:      30000
    });

    res.status(upstream.status);
    ["content-type","content-length","content-range","accept-ranges","cache-control"].forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    upstream.data.pipe(res);
  } catch(e) {
    console.error("[/proxy]", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Nexora Proxy on port ${PORT}`);
  console.log(`   Mirrors: ${MIRROR_HOSTS.length}`);
  // Pre-warm sessions on startup
  sessions.forEach(s => s.init().catch(() => {}));
});
