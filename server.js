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

// ── FIX 1: Content-Type REMOVED from DEFAULT_HEADERS ──────────────────────────
// The original code had "Content-Type": "application/json" here.
// This header was being forwarded to video CDNs when proxying segments,
// which corrupted the request and caused CDNs to reject or misbehave —
// killing the audio track entirely. Content-Type belongs on POST bodies only.
const DEFAULT_HEADERS = {
  "Accept":          "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.5",
  "X-Client-Info":   '{"timezone":"Africa/Nairobi"}',
  "User-Agent":      "moviebox-js-sdk/preview",
};

// Separate headers for API calls that actually send JSON bodies
const JSON_HEADERS = {
  ...DEFAULT_HEADERS,
  "Content-Type": "application/json",
};

const APP_INFO_PATH = "/wefeed-h5-bff/app/get-latest-app-pkgs";
const STREAM_PATH   = "/wefeed-h5-bff/web/subject/play";
const DOWNLOAD_PATH = "/wefeed-h5-bff/web/subject/download";
const SEARCH_PATH   = "/wefeed-h5-bff/web/subject/search";

// ── SESSION CLASS ──────────────────────────────────────────────────────────────
class Session {
  constructor(host) {
    this.host        = host;
    this.baseUrl     = `https://${host}`;
    this.cookies     = new Map();
    this.initialized = false;
    // FIX 2: Track the init promise so parallel requests don't race
    this._initPromise = null;
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

  // FIX 2: init() now returns the same promise for concurrent callers
  // so the first request doesn't race against pre-warm — both await the same init.
  init() {
    if (this.initialized) return Promise.resolve();
    if (this._initPromise) return this._initPromise;
    this._initPromise = axios.get(`${this.baseUrl}${APP_INFO_PATH}?app_name=moviebox`, {
      headers: { ...JSON_HEADERS, Cookie: this.cookieHeader() },
      timeout: 8000,
      validateStatus: () => true
    }).then(res => {
      this.storeCookies(res.headers);
      this.initialized = true;
      console.log(`[Session:${this.host}] init OK, cookies:${this.cookies.size}`);
    }).catch(e => {
      this.initialized = true; // Mark done even on failure so we don't loop
      console.warn(`[Session:${this.host}] init failed:`, e.message);
    }).finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  async get(path, params = {}, extraHeaders = {}) {
    await this.init();
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, String(v)));
    const res = await axios.get(url.toString(), {
      // FIX 1: Use JSON_HEADERS for API calls (has Content-Type: application/json)
      headers: { ...JSON_HEADERS, ...extraHeaders, Cookie: this.cookieHeader() },
      timeout: 10000,
      validateStatus: () => true
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
      // FIX 1: Use JSON_HEADERS for POST (has Content-Type: application/json)
      headers: { ...JSON_HEADERS, Cookie: this.cookieHeader() },
      timeout: 10000,
      validateStatus: () => true
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

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({ status:"ok", version:"2.1" }));

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

// STREAM
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

// ── FIX 3: M3U8 SEGMENT REWRITER ──────────────────────────────────────────────
// When an HLS .m3u8 manifest is proxied, the segment URLs inside it are absolute
// CDN URLs (e.g. https://cdn.example.com/seg001.ts). The browser/HLS.js then
// tries to fetch those directly — which fails CORS and loses the audio track.
// This function rewrites every segment URL in the manifest to go through /proxy.
function rewriteM3U8(body, proxyBase, originalUrl) {
  const base = originalUrl.substring(0, originalUrl.lastIndexOf("/") + 1);

  return body.split("\n").map(line => {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) return line;

    let absoluteUrl;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      absoluteUrl = trimmed;
    } else if (trimmed.startsWith("/")) {
      // Root-relative URL
      const u = new URL(originalUrl);
      absoluteUrl = `${u.origin}${trimmed}`;
    } else {
      // Relative URL — resolve against the manifest's base path
      absoluteUrl = base + trimmed;
    }

    return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}`;
  }).join("\n");
}

// Also rewrite URI= values inside #EXT-X-KEY and #EXT-X-MAP tags
function rewriteM3U8Tags(body, proxyBase, originalUrl) {
  const base = originalUrl.substring(0, originalUrl.lastIndexOf("/") + 1);
  const u    = new URL(originalUrl);

  return body.replace(/URI="([^"]+)"/g, (match, uri) => {
    let abs;
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      abs = uri;
    } else if (uri.startsWith("/")) {
      abs = `${u.origin}${uri}`;
    } else {
      abs = base + uri;
    }
    return `URI="${proxyBase}/proxy?url=${encodeURIComponent(abs)}"`;
  });
}

// ── VIDEO / M3U8 PROXY ────────────────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error:"Missing url" });

  const targetUrl = decodeURIComponent(url);
  const session   = sessions[currentIdx] || sessions[0];

  // FIX 1: Do NOT include Content-Type when proxying video/media resources
  // Only forward actual request metadata headers
  const forwardHeaders = {
    ...DEFAULT_HEADERS,          // No Content-Type in here anymore
    Cookie:   session.cookieHeader(),
    Referer:  session.baseUrl,
    Origin:   session.baseUrl,
  };

  // Forward Range header — essential for video seeking and audio segment sync
  if (req.headers["range"])           forwardHeaders["Range"]           = req.headers["range"];
  if (req.headers["accept-encoding"]) forwardHeaders["Accept-Encoding"] = req.headers["accept-encoding"];
  if (req.headers["if-range"])        forwardHeaders["If-Range"]        = req.headers["if-range"];

  try {
    const upstream = await axios({
      method:       "GET",
      url:          targetUrl,
      headers:      forwardHeaders,
      responseType: "arraybuffer",   // Use arraybuffer so we can inspect/rewrite m3u8 text
      timeout:      60000,
      decompress:   false,
      maxRedirects: 5,
      httpAgent:    new http.Agent({ keepAlive: true }),
      httpsAgent:   new https.Agent({ keepAlive: true }),
      validateStatus: () => true,
    });

    const contentType = (upstream.headers["content-type"] || "").toLowerCase();
    const isM3U8 = (
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl") ||
      targetUrl.includes(".m3u8")
    );

    // ── FIX 3: If this is an m3u8 manifest, rewrite segment URLs ──
    if (isM3U8 && upstream.status >= 200 && upstream.status < 300) {
      let text = Buffer.from(upstream.data).toString("utf8");
      const proxyBase = `${req.protocol}://${req.get("host")}`;

      text = rewriteM3U8(text, proxyBase, targetUrl);
      text = rewriteM3U8Tags(text, proxyBase, targetUrl);

      res.status(200);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin",   "*");
      res.setHeader("Access-Control-Allow-Headers",  "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Accept-Ranges");
      res.setHeader("Cache-Control", "no-cache");
      return res.send(text);
    }

    // ── Regular media pass-through (video segments, mp4, etc.) ──
    res.status(upstream.status);

    const passHeaders = [
      "content-type", "content-length", "content-range",
      "accept-ranges", "cache-control", "etag",
      "last-modified", "expires", "content-encoding"
    ];
    passHeaders.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    res.setHeader("Access-Control-Allow-Origin",   "*");
    res.setHeader("Access-Control-Allow-Headers",  "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");

    res.send(Buffer.from(upstream.data));

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
  console.log(`✅ Nexora Proxy v2.1 on port ${PORT}`);
  // Pre-warm sessions — stagger them so they don't all hammer at once
  sessions.forEach((s, i) => setTimeout(() => s.init().catch(()=>{}), i * 300));
});
