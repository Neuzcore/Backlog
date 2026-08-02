// worker.js — gemeinsamer KV-Store für alle persönlichen PWAs.
// Ein Worker + ein KV-Namespace bedienen alle Apps, getrennt über Key-Präfixe.
//
// Routen:
//   GET    /<app>/<key>   -> JSON lesen        (404 wenn nicht vorhanden)
//   PUT    /<app>/<key>   -> JSON speichern     (Body = gültiges JSON)
//   DELETE /<app>/<key>   -> löschen
//   GET    /<app>         -> Keys der App auflisten (mit ?cursor= paginierbar)
//
// Zusätzlich (kein KV, sondern IGDB-Proxy):
//   GET    /igdb/search?q=...   -> Spielsuche, max. 15 Treffer
//   GET    /igdb/artwork?id=... -> Cover/Screenshots eines Spiels

const ALLOWED_ORIGINS = [
  "https://neuzcore.github.io",
  // "https://deine-custom-domain.de",
  // "http://localhost:8080",   // für lokale Entwicklung freischalten
];

const ALLOWED_APPS = [
  "finanzen",
  "cookingcat",
  "packliste",
  "gamingbacklog",
  "bibliothek",
  "workoutdb",
  "trainingplanner",
  "pkv",
  "codex",
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // Preflight: ohne Auth beantworten (Browser senden hier keinen Auth-Header)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Auth: gemeinsames Secret
    if (!checkAuth(request, env.APP_SECRET)) {
      return json({ error: "unauthorized" }, 401, cors);
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const app = parts[0];
    const key = parts.slice(1).map(decodeURIComponent).join("/");

    // IGDB-Suchproxy (keine KV-App, daher vor der Allowlist-Prüfung)
    if (app === "igdb") {
      const action = parts[1] || "";
      try {
        if (request.method === "GET" && action === "search") {
          const q = (url.searchParams.get("q") || "").trim();
          if (!q) return json({ results: [] }, 200, cors);
          return json({ results: await igdbSearch(env, q) }, 200, cors);
        }
        if (request.method === "GET" && action === "artwork") {
          const id = parseInt(url.searchParams.get("id") || "0", 10);
          if (!id) return json({ images: [] }, 200, cors);
          return json({ images: await igdbArtwork(env, id) }, 200, cors);
        }
      } catch (err) {
        return json({ error: "igdb: " + err.message }, 502, cors);
      }
      return json({ error: "unknown igdb route" }, 404, cors);
    }

    if (!app || !ALLOWED_APPS.includes(app)) {
      return json({ error: "unknown app" }, 404, cors);
    }

    try {
      // GET /<app>  -> Keys auflisten
      if (request.method === "GET" && !key) {
        const cursor = url.searchParams.get("cursor") || undefined;
        const list = await env.KV.list({ prefix: app + ":", cursor });
        return json(
          {
            keys: list.keys.map((k) => k.name.slice(app.length + 1)),
            cursor: list.list_complete ? null : list.cursor,
          },
          200,
          cors
        );
      }

      if (!key) return json({ error: "key required" }, 400, cors);

      const kvKey = `${app}:${key}`;

      // GET /<app>/<key>
      if (request.method === "GET") {
        const value = await env.KV.get(kvKey);
        if (value === null) return json({ error: "not found" }, 404, cors);
        return new Response(value, {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      // PUT /<app>/<key>
      if (request.method === "PUT") {
        const body = await request.text();
        try {
          JSON.parse(body); // nur gültiges JSON zulassen
        } catch {
          return json({ error: "invalid JSON body" }, 400, cors);
        }
        await env.KV.put(kvKey, body);
        return json({ ok: true }, 200, cors);
      }

      // DELETE /<app>/<key>
      if (request.method === "DELETE") {
        await env.KV.delete(kvKey);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: "method not allowed" }, 405, cors);
    } catch {
      return json({ error: "server error" }, 500, cors);
    }
  },
};

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function checkAuth(request, secret) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(secret) && constantTimeEqual(token, secret);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ─── IGDB ───────────────────────────────────────────────────────────────────
// Braucht die Secrets IGDB_CLIENT_ID und IGDB_CLIENT_SECRET
// (per `wrangler secret put` gesetzt, siehe dev.twitch.tv/console).

const IGDB_TOKEN_KEY = "_igdb:token";
const IGDB_IMG = "https://images.igdb.com/igdb/image/upload";

// App-Access-Token von Twitch holen und in KV zwischenspeichern.
// Tokens gelten rund 60 Tage; Erneuerung eine Stunde vor Ablauf.
async function getIgdbToken(env) {
  const cached = await env.KV.get(IGDB_TOKEN_KEY, "json");
  if (cached && cached.access_token && cached.expires_at > Date.now()) {
    return cached.access_token;
  }

  const url =
    "https://id.twitch.tv/oauth2/token" +
    "?client_id=" + encodeURIComponent(env.IGDB_CLIENT_ID) +
    "&client_secret=" + encodeURIComponent(env.IGDB_CLIENT_SECRET) +
    "&grant_type=client_credentials";

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) throw new Error("token " + res.status);
  const data = await res.json();
  if (!data.access_token) throw new Error("no token in response");

  const token = {
    access_token: data.access_token,
    expires_at: Date.now() + ((data.expires_in || 5000000) - 3600) * 1000,
  };
  await env.KV.put(IGDB_TOKEN_KEY, JSON.stringify(token));
  return token.access_token;
}

// Apicalypse-Abfrage gegen IGDB ausführen.
async function igdbQuery(env, endpoint, body) {
  const token = await getIgdbToken(env);
  const res = await fetch("https://api.igdb.com/v4/" + endpoint, {
    method: "POST",
    headers: {
      "Client-ID": env.IGDB_CLIENT_ID,
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) throw new Error(endpoint + " " + res.status);
  return res.json();
}

// Spielsuche. IGDB hat `category` durch `game_type` ersetzt, deshalb fragen
// wir alle Felder ab und filtern hier — je nachdem, welches Feld vorhanden ist.
// Erlaubt sind Hauptspiel (0), Remake (8), Remaster (9), erweiterte Fassung (10)
// und Port (11); DLCs, Mods, Bundles und Episoden fallen raus.
const IGDB_MAIN_TYPES = [0, 8, 9, 10, 11];

async function igdbSearch(env, q) {
  const safe = q.replace(/["\\]/g, "").slice(0, 100);
  const body =
    'search "' + safe + '"; ' +
    "fields *,cover.image_id,platforms.name,genres.name," +
    "involved_companies.company.name; " +
    "limit 40;";

  const rows = await igdbQuery(env, "games", body);

  const filtered = rows.filter((g) => {
    if (g.version_parent) return false; // alternative Editionen ausblenden
    const type = g.game_type ?? g.category;
    if (type === undefined || type === null) return true; // Feld fehlt -> durchlassen
    return IGDB_MAIN_TYPES.includes(type);
  });

  return filtered.slice(0, 15).map((g) => ({
    id: g.id,
    name: g.name,
    cover: g.cover?.image_id
      ? IGDB_IMG + "/t_cover_big/" + g.cover.image_id + ".jpg"
      : null,
    year: g.first_release_date
      ? new Date(g.first_release_date * 1000).getUTCFullYear()
      : null,
    platforms: (g.platforms || []).map((p) => p.name),
    genres: (g.genres || []).map((x) => x.name),
    developer: g.involved_companies?.[0]?.company?.name || null,
  }));
}

// Cover, Screenshots und Artworks eines Spiels für den Cover-Picker.
async function igdbArtwork(env, id) {
  const body =
    "fields cover.image_id,screenshots.image_id,artworks.image_id; " +
    "where id = " + id + "; limit 1;";
  const rows = await igdbQuery(env, "games", body);
  const g = rows[0];
  if (!g) return [];

  const out = [];
  if (g.cover?.image_id) {
    out.push(IGDB_IMG + "/t_cover_big/" + g.cover.image_id + ".jpg");
  }
  for (const s of g.screenshots || []) {
    out.push(IGDB_IMG + "/t_720p/" + s.image_id + ".jpg");
  }
  for (const a of g.artworks || []) {
    out.push(IGDB_IMG + "/t_720p/" + a.image_id + ".jpg");
  }
  return out;
}
