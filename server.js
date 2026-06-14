// ═══════════════════════════════════════════════
// NEXORA PROXY SERVER
// Bridges your browser ↔ MovieBox API
// Deploy free on Railway
// ═══════════════════════════════════════════════

const express  = require("express");
const axios    = require("axios");
const cors     = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Allow your Nexora frontend to call this server ──
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── MovieBox mirror hosts (from your SDK) ──
const MB_HOSTS = [
  "h5.aoneroom.com",
  "movieboxapp.in",
  "moviebox.pk",
  "moviebox.ph",
  "moviebox.id",
  "v.moviebox.ph",
  "netnaija.video"
];

// ── Shared headers MovieBox expects ──
const MB_HEADERS = {
  "Accept":           "application/json",
  "Accept-Language":  "en-US,en;q=0.9",
  "Content-Type":     "application/json",
  "X-Client-Info":    JSON.stringify({ timezone: "Africa/Nairobi" }),
  "User-Agent":       "MovieBox/5.0 (Android; Mobile)"
};

// ── Try each mirror until one works ──
async function mbPost(path, body) {
  let lastErr;
  for (const host of MB_HOSTS) {
    try {
      const url = `https://${host}${path}`;
      console.log(`[MB] POST ${url}`);
      const res = await axios.post(url, body, {
        headers: MB_HEADERS,
        timeout: 8000
      });
      const json = res.data;
      // Unwrap MovieBox envelope { code:0, data:{...} }
      if (json && json.code === 0 && json.data !== undefined) return json.data;
      if (json && json.code !== 0) throw new Error(`MB error: ${json.message || json.code}`);
      return json;
    } catch (e) {
      console.warn(`[MB] ${host} failed:`, e.message);
      lastErr = e;
    }
  }
  throw lastErr || new Error("All MovieBox mirrors failed");
}

async function mbGet(path, params = {}) {
  let lastErr;
  const qs = new URLSearchParams(params).toString();
  const fullPath = qs ? `${path}?${qs}` : path;
  for (const host of MB_HOSTS) {
    try {
      const url = `https://${host}${fullPath}`;
      console.log(`[MB] GET ${url}`);
      const res = await axios.get(url, {
        headers: MB_HEADERS,
        timeout: 8000
      });
      const json = res.data;
      if (json && json.code === 0 && json.data !== undefined) return json.data;
      if (json && json.code !== 0) throw new Error(`MB error: ${json.message || json.code}`);
      return json;
    } catch (e) {
      console.warn(`[MB] ${host} failed:`, e.message);
      lastErr = e;
    }
  }
  throw lastErr || new Error("All MovieBox mirrors failed");
}

// ═══════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Nexora Proxy", version: "1.0.0" });
});

// ── SEARCH ──────────────────────────────────────
// GET /search?q=avengers&type=movie&page=1
app.get("/search", async (req, res) => {
  const { q, type = "all", page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });

  const typeMap = { all: 0, movie: 1, tv: 2, music: 6 };

  try {
    const data = await mbPost("/wefeed-h5-bff/web/subject/search", {
      keyword:     q,
      page:        parseInt(page),
      perPage:     24,
      subjectType: typeMap[type] ?? 0
    });

    const results = (data.items || []).map(item => ({
      id:          item.subjectId,
      title:       item.title,
      type:        item.subjectType === 1 ? "movie" : item.subjectType === 2 ? "tv" : "other",
      description: item.description || "",
      releaseYear: item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : null,
      rating:      parseFloat(item.imdbRatingValue) || null,
      posterUrl:   item.cover?.url || item.image?.url || null,
      detailPath:  item.detailPath || null,
      hasResource: Boolean(item.hasResource)
    }));

    res.json({
      results,
      hasMore:   data.pager?.hasMore ?? false,
      nextPage:  data.pager?.hasMore ? parseInt(data.pager.nextPage) : null,
      total:     parseInt(data.pager?.totalCount || 0)
    });
  } catch (e) {
    console.error("[/search]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── STREAM ──────────────────────────────────────
// GET /stream?id=12345&season=0&episode=0
app.get("/stream", async (req, res) => {
  const { id, season = 0, episode = 0 } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    const data = await mbGet("/wefeed-h5-bff/web/subject/play", {
      subjectId: id,
      se: parseInt(season),
      ep: parseInt(episode)
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
  } catch (e) {
    console.error("[/stream]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── DOWNLOAD ────────────────────────────────────
// GET /download?id=12345&season=0&episode=0
app.get("/download", async (req, res) => {
  const { id, season = 0, episode = 0 } = req.query;
  if (!id) return res.status(400).json({ error: "Missing id" });

  try {
    const data = await mbGet("/wefeed-h5-bff/web/subject/download", {
      subjectId: id,
      se: parseInt(season),
      ep: parseInt(episode)
    });

    const downloads = (data.downloads || [])
      .map(d => ({
        id:         d.id,
        quality:    `${d.resolution}p`,
        resolution: d.resolution,
        url:        d.url,
        size:       d.size
      }))
      .sort((a, b) => a.resolution - b.resolution);

    const captions = (data.captions || []).map(c => ({
      id:       c.id,
      language: c.lanName,
      code:     c.lan,
      url:      c.url
    }));

    res.json({ downloads, captions, hasResource: data.hasResource || false });
  } catch (e) {
    console.error("[/download]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── FIND BY TITLE ────────────────────────────────
// GET /find?title=Avengers&year=2019&type=movie
// Searches MB and returns the best matching item with streams
app.get("/find", async (req, res) => {
  const { title, year, type = "movie" } = req.query;
  if (!title) return res.status(400).json({ error: "Missing title" });

  const typeMap = { movie: 1, tv: 2 };

  try {
    const data = await mbPost("/wefeed-h5-bff/web/subject/search", {
      keyword:     title,
      page:        1,
      perPage:     10,
      subjectType: typeMap[type] ?? 0
    });

    const items = (data.items || []).map(item => ({
      id:          item.subjectId,
      title:       item.title,
      type:        item.subjectType === 1 ? "movie" : "tv",
      releaseYear: item.releaseDate ? parseInt(item.releaseDate.slice(0, 4)) : null,
      rating:      parseFloat(item.imdbRatingValue) || null,
      posterUrl:   item.cover?.url || item.image?.url || null,
      detailPath:  item.detailPath || null,
      hasResource: Boolean(item.hasResource)
    }));

    // Score matches — title similarity + year match
    const scored = items.map(item => {
      let score = 0;
      const t1 = item.title.toLowerCase().trim();
      const t2 = title.toLowerCase().trim();
      if (t1 === t2) score += 100;
      else if (t1.includes(t2) || t2.includes(t1)) score += 60;
      else {
        // Word overlap score
        const w1 = new Set(t1.split(/\s+/));
        const w2 = t2.split(/\s+/);
        const overlap = w2.filter(w => w1.has(w)).length;
        score += overlap * 15;
      }
      if (year && item.releaseYear) {
        if (Math.abs(item.releaseYear - parseInt(year)) === 0) score += 30;
        else if (Math.abs(item.releaseYear - parseInt(year)) <= 1) score += 10;
      }
      if (item.hasResource) score += 20;
      return { ...item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0] || null;

    if (!best || best.score < 20) {
      return res.json({ found: false, item: null });
    }

    res.json({ found: true, item: best });
  } catch (e) {
    console.error("[/find]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── STREAM PROXY ─────────────────────────────────
// GET /proxy?url=https://...
// Proxies a video stream URL to bypass CORS on the actual video file
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  try {
    const range = req.headers.range;
    const headers = { ...MB_HEADERS };
    if (range) headers["Range"] = range;

    const upstream = await axios({
      method:       "GET",
      url:          decodeURIComponent(url),
      headers,
      responseType: "stream",
      timeout:      30000
    });

    // Forward status + headers
    res.status(upstream.status);
    const forward = ["content-type","content-length","content-range","accept-ranges","cache-control"];
    forward.forEach(h => { if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]); });
    res.setHeader("Access-Control-Allow-Origin", "*");

    upstream.data.pipe(res);
  } catch (e) {
    console.error("[/proxy]", e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── START ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Nexora Proxy running on port ${PORT}`);
  console.log(`   MovieBox mirrors: ${MB_HOSTS.length}`);
});
