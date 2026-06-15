const express = require("express");
const axios   = require("axios");
const cors    = require("cors");
const http    = require("http");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const MIRROR_HOSTS = [
  "h5.aoneroom.com",
  "movieboxapp.in",
  "moviebox.pk",
  "moviebox.ph",
  "moviebox.id",
  "v.moviebox.ph",
  "netnaija.video"
];

const DEFAULT_HEADERS = {
  "Accept":          "application/json",
  "Accept-Language": "en-US,en;q=0.5",
  "X-Client-Info":   '{"timezone":"Africa/Nairobi"}',
  "User-Agent":      "moviebox-js-sdk/preview",
  "Content-Type":    "application/json"
};

const APP_INFO_PATH = "/wefeed-h5-bff/app/get-latest-app-pkgs";
const STREAM_PATH   = "/wefeed-h5-bff/web/subject/play";
const DOWNLOAD_PATH = "/wefeed-h5-bff/web/subject/download";
const SEARCH_PATH   = "/wefeed-h5-bff/web/subject/search";

// ── SESSION CLASS ──────────────────────────────
class Session {
  constructor(host) {
    this.host        = host;
    this.baseUrl     = `https://${host}`;
    this.cookies     = new Map();
    this.initialized = false;
  }

  storeCookies(headers) {
    const raw = headers["set-cookie"];
    if (!raw) return;
    (Array.isArray(raw) ? raw : [raw]).forEach(cookie => {
      const [pair] = cookie.split(";");
      if (!pair) return;
      const eq = pair.indexOf("=");
      if (eq === -1) return;
      const name  = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name && value) this.cookies.set(name, value);
      else if (name)     this.cookies.delete(name);
    });
  }

  cookieHeader() {
    return Array.from(this.cookies.entries()).map(([k,v]) => `${k}=${v}`).join("; ");
  }

  async init() {
    if (this.initialized) return;
    try {
      const res = await axios.get(`${this.baseUrl}${APP_INFO_PATH}?app_name=moviebox`, {
        headers: { ...DEFAULT_HEADERS, Cookie: this.cookieHeader() },
        timeout: 8000, validateStatus: () => true
      });
      this.storeCookies(res.headers);
      this.initialized = true;
      console.log(`[Session:${this.host}] init OK, cookies:${this.cookies.size}`);
    } catch(e) {
      this.initialized = true;
      console.warn(`[Session:${this.host}] init failed:`, e.message);
    }
  }

  async get(path, params = {}, extraHeaders = {}) {
    await this.init();
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
    const res = await axios.get(url.toString(), {
      headers: { ...DEFAULT_HEADERS, ...extraHeaders, Cookie: this.cookieHeader() },
      timeout: 10000, validateStatus: () => true
    });
    this.storeCookies(res.headers);
    if (res.status === 403 || res.status === 451) throw new Error(`Blocked:${res.status}`);
    if (!String(res.status).startsWith("2")) throw new Error(`HTTP:${res.status}`);
    const j = res.data;
    if (j && typeof j.code === "number") {
      if (j.code === 0 && j.data !== undefined) return j.data;
      throw new Error(`API:${j.code}:${j.message}`);
    }
    return j;
  }

  async post(path, body = {}) {
    await this.init();
    const res = await axios.post(`${this.baseUrl}${path}`, body, {
      headers: { ...DEFAULT_HEADERS, Cookie: this.cookieHeader() },
      timeout: 10000, validateStatus: () => true
    });
    this.storeCookies(res.headers);
    if (!String(res.status).startsWith("2")) throw new Error(`HTTP:${res.status}`);
    const j = res.data;
    if (j && typeof j.code === "number") {
      if (j.code === 0 && j.data !== undefined) return j.data;
      throw new Error(`API:${j.code}:${j.message}`);
    }
    return j;
  }
}

const sessions   = MIRROR_HOSTS.map(h => new Session(h));
let currentIdx   = 0;

async function withMirror(fn) {
  const start = currentIdx;
  for (let i = 0; i < sessions.length; i++) {
    const idx = (start + i) % sessions.length;
    try {
      const result = await fn(sessions[idx]);
      currentIdx = idx;
      return result;
    } catch(e) {
      console.warn(`[Mirror:${sessions[idx].host}]`, e.message);
    }
  }
  throw new Error("All mirrors failed");
}

// ── ROUTES ─────────────────────────────────────

app.get("/", (req, res) => res.json({ status:"ok", version:"2.0" }));

// SEARCH
app.get("/search", async (req, res) => {
  const { q, type="all", page=1 } = req.query;
  if (!q) return res.status(400).json({ error:"Missing q" });
  const typeMap = { all:0, movie:1, tv:2 };
  try {
    const data = await withMirror(s => s.post(SEARCH_PATH, {
      keyword: q, page: parseInt(page), perPage: 24,
      subjectType: typeMap[type] ?? 0
    }));
    res.json({
      results: (data.items||[]).map(item => ({
        id:          item.subjectId,
        title:       item.title,
        type:        item.subjectType===1?"movie":item.subjectType===2?"tv":"other",
        description: item.description||"",
        releaseYear: item.releaseDate ? parseInt(item.releaseDate.slice(0,4)) : null,
        rating:      parseFloat(item.imdbRatingValue)||null,
        posterUrl:   item.cover?.url||item.image?.url||null,
        detailPath:  item.detailPath||null,
        hasResource: Boolean(item.hasResource)
      })),
      hasMore:  data.pager?.hasMore??false,
      nextPage: data.pager?.hasMore ? parseInt(data.pager.nextPage) : null,
      total:    parseInt(data.pager?.totalCount||0)
    });
  } catch(e) { res.status(502).json({ error:e.message }); }
});

// FIND BEST MATCH
app.get("/find", async (req, res) => {
  const { title, year, type="movie" } = req.query;
  if (!title) return res.status(400).json({ error:"Missing title" });
  const typeMap = { movie:1, tv:2 };
  try {
    const data = await withMirror(s => s.post(SEARCH_PATH, {
      keyword: title, page:1, perPage:10,
      subjectType: typeMap[type]??0
    }));
    const items = (data.items||[]).map(item => ({
      id:          item.subjectId,
      title:       item.title,
      type:        item.subjectType===1?"movie":"tv",
      releaseYear: item.releaseDate ? parseInt(item.releaseDate.slice(0,4)) : null,
      posterUrl:   item.cover?.url||item.image?.url||null,
      detailPath:  item.detailPath||null,
      hasResource: Boolean(item.hasResource)
    }));
    const scored = items.map(item => {
      let score = 0;
      const t1 = item.title.toLowerCase().trim();
      const t2 = String(title).toLowerCase().trim();
      if (t1===t2) score+=100;
      else if (t1.includes(t2)||t2.includes(t1)) score+=60;
      else score += t2.split(/\s+/).filter(w=>new Set(t1.split(/\s+/)).has(w)).length*15;
      if (year && item.releaseYear) {
        if (Math.abs(item.releaseYear-parseInt(year))===0) score+=30;
        else if (Math.abs(item.releaseYear-parseInt(year))<=1) score+=10;
      }
      if (item.hasResource) score+=20;
      return { ...item, score };
    }).sort((a,b)=>b.score-a.score);
    const best = scored[0];
    res.json({ found:!!(best&&best.score>=20), item:best||null });
  } catch(e) { res.status(502).json({ error:e.message }); }
});

// STREAM — with Referer + cookies
app.get("/stream", async (req, res) => {
  const { id, detailPath, season=0, episode=0 } = req.query;
  if (!id) return res.status(400).json({ error:"Missing id" });
  try {
    const data = await withMirror(async session => {
      const slug    = detailPath ? String(detailPath).split("/").filter(Boolean).pop() : id;
      const referer = `${session.baseUrl}/movies/${slug}`;
      return session.get(STREAM_PATH,
        { subjectId:id, se:parseInt(season), ep:parseInt(episode) },
        { Referer: referer, Origin: session.baseUrl }
      );
    });
    const streams = (data.streams||[])
      .map(s => ({ id:s.id, quality:`${s.resolutions}p`, resolution:parseInt(s.resolutions)||0, url:s.url, format:s.format||"mp4", size:parseInt(s.size)||0 }))
      .sort((a,b)=>a.resolution-b.resolution);
    res.json({ streams, best:streams[streams.length-1]||null, hasResource:data.hasResource||false });
  } catch(e) { res.status(502).json({ error:e.message }); }
});

// DOWNLOAD
app.get("/download", async (req, res) => {
  const { id, detailPath, season=0, episode=0 } = req.query;
  if (!id) return res.status(400).json({ error:"Missing id" });
  try {
    const data = await withMirror(async session => {
      const slug    = detailPath ? String(detailPath).split("/").filter(Boolean).pop() : id;
      const referer = `${session.baseUrl}/movies/${slug}`;
      return session.get(DOWNLOAD_PATH,
        { subjectId:id, se:parseInt(season), ep:parseInt(episode) },
        { Referer: referer, Origin: session.baseUrl }
      );
    });
    const downloads = (data.downloads||[])
      .map(d => ({ id:d.id, quality:`${d.resolution}p`, resolution:d.resolution, url:d.url, size:d.size }))
      .sort((a,b)=>a.resolution-b.resolution);
    const captions = (data.captions||[]).map(c => ({ id:c.id, language:c.lanName, code:c.lan, url:c.url }));
    res.json({ downloads, captions, hasResource:data.hasResource||false });
  } catch(e) { res.status(502).json({ error:e.message }); }
});

// ── VIDEO PROXY — FIXED with proper Range support ─────────
// This is what was causing the audio issue — Range headers
// are essential for video streaming (seeking, audio sync)
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error:"Missing url" });

  const targetUrl = decodeURIComponent(url);
  const session   = sessions[currentIdx] || sessions[0];

  // Forward all range/cache headers from client
  const forwardHeaders = {
    ...DEFAULT_HEADERS,
    Cookie:   session.cookieHeader(),
    Referer:  session.baseUrl,
    Origin:   session.baseUrl,
  };

  // ← KEY FIX: forward Range header for video seeking + audio sync
  if (req.headers.range)              forwardHeaders["Range"]              = req.headers.range;
  if (req.headers["accept-encoding"]) forwardHeaders["Accept-Encoding"]   = req.headers["accept-encoding"];
  if (req.headers["if-range"])        forwardHeaders["If-Range"]          = req.headers["if-range"];

  try {
    const upstream = await axios({
      method:       "GET",
      url:          targetUrl,
      headers:      forwardHeaders,
      responseType: "stream",
      timeout:      60000,
      // Don't decompress — pass through as-is
      decompress:   false,
      // Follow redirects
      maxRedirects: 5,
      httpAgent:    new http.Agent({ keepAlive: true }),
      httpsAgent:   new https.Agent({ keepAlive: true })
    });

    // ← KEY: forward 206 Partial Content status (needed for audio)
    res.status(upstream.status);

    // Forward ALL media headers
    const passHeaders = [
      "content-type", "content-length", "content-range",
      "accept-ranges", "cache-control", "etag",
      "last-modified", "expires", "content-encoding"
    ];
    passHeaders.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    // CORS
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers","Content-Range, Content-Length, Accept-Ranges");

    // Pipe stream
    upstream.data.pipe(res);

    upstream.data.on("error", err => {
      console.error("[proxy stream error]", err.message);
      if (!res.headersSent) res.status(502).end();
    });

  } catch(e) {
    console.error("[/proxy]", e.message);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  }
});

// Handle preflight
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`✅ Nexora Proxy v2 on port ${PORT}`);
  // Pre-warm all sessions
  sessions.forEach(s => s.init().catch(()=>{}));
});
