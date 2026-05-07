// Live podium for the MTM End of Year Journey.
//
// Storage tiers (in order of preference):
//   1. Vercel KV (Upstash Redis) — uses KV_REST_API_URL + KV_REST_API_TOKEN
//      env vars that Vercel auto-injects when you connect a KV database.
//      This is what handles real concurrency (50+ families at once).
//   2. In-memory Map — fallback when KV is not configured. Works for very
//      small events but each Vercel instance keeps its own copy, so data
//      gets fragmented under load.
//
// To enable KV:
//   Vercel dashboard → Project → Storage tab → Create Database → KV
//   Connect it to this project. Redeploy. Done.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_AVAILABLE = !!(KV_URL && KV_TOKEN);

const FAMILIES_KEY = "mtm:families";
const TOTAL_STATIONS = 20;
const MAX_NAME_LEN = 60;
const MAX_RETURNED = 200;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const KV_TTL_SECONDS = 60 * 60 * 24; // auto-clean after 24h

// In-memory fallback bucket
if (!globalThis.__mtmFamilies) {
  globalThis.__mtmFamilies = new Map();
}
const memFamilies = globalThis.__mtmFamilies;

// Talk to Upstash REST API. Body is an array — first element is the Redis
// command, the rest are arguments. Returns the parsed `result` field.
async function kvCommand(...args) {
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  if (!r.ok) {
    throw new Error(`KV ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  return data.result;
}

async function setFamily(family) {
  const json = JSON.stringify(family);
  if (KV_AVAILABLE) {
    await kvCommand("HSET", FAMILIES_KEY, family.id, json);
    // Refresh TTL on every write so the key keeps alive during the event
    await kvCommand("EXPIRE", FAMILIES_KEY, KV_TTL_SECONDS);
  } else {
    memFamilies.set(family.id, family);
  }
}

async function getAllFamilies() {
  if (KV_AVAILABLE) {
    const result = await kvCommand("HGETALL", FAMILIES_KEY);
    if (!Array.isArray(result)) return [];
    const families = [];
    for (let i = 0; i < result.length; i += 2) {
      try {
        families.push(JSON.parse(result[i + 1]));
      } catch { /* skip malformed */ }
    }
    return families;
  }
  return Array.from(memFamilies.values());
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function compareFamilies(a, b) {
  if (b.stamps !== a.stamps) return b.stamps - a.stamps;
  if (a.completedAt && b.completedAt) return a.completedAt - b.completedAt;
  if (a.completedAt) return -1;
  if (b.completedAt) return 1;
  return (b.lastUpdate || 0) - (a.lastUpdate || 0);
}

function computeCongestion(list, excludeId) {
  const now = Date.now();
  const congestion = {};
  for (const f of list) {
    if (excludeId && f.id === excludeId) continue;
    if (!f.lastUpdate || (now - f.lastUpdate) > ACTIVE_WINDOW_MS) continue;
    const ids = f.unlockedNotStamped || [];
    for (const sid of ids) {
      congestion[sid] = (congestion[sid] || 0) + 1;
    }
  }
  return congestion;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      body = body || {};

      const id = String(body.id || "").trim().slice(0, 40);
      const name = String(body.name || "").trim().slice(0, MAX_NAME_LEN);
      if (!id || !name) {
        res.status(400).json({ error: "id and name required" });
        return;
      }

      const stamps = clamp(body.stamps, 0, TOTAL_STATIONS);
      const startedAt = Number(body.startedAt) || Date.now();
      const completedAt = body.completedAt ? Number(body.completedAt) : null;

      let unlockedNotStamped = [];
      if (Array.isArray(body.unlockedNotStamped)) {
        unlockedNotStamped = body.unlockedNotStamped
          .map(n => Number(n))
          .filter(n => Number.isInteger(n) && n >= 1 && n <= TOTAL_STATIONS)
          .slice(0, TOTAL_STATIONS);
      }

      // Preserve original startedAt across updates
      const all = await getAllFamilies();
      const existing = all.find(f => f.id === id) || {};

      const family = {
        id,
        name,
        stamps,
        startedAt: existing.startedAt || startedAt,
        completedAt: completedAt || existing.completedAt || null,
        unlockedNotStamped,
        lastUpdate: Date.now()
      };

      await setFamily(family);

      // Compute fresh congestion that already includes this family's update
      const updated = (await getAllFamilies()).sort(compareFamilies);
      const congestion = computeCongestion(updated, id);

      res.status(200).json({
        ok: true,
        congestion,
        timestamp: Date.now(),
        backend: KV_AVAILABLE ? "kv" : "memory"
      });
      return;
    }

    if (req.method === "GET") {
      const requesterId = String(req.query?.id || "").trim().slice(0, 40);
      const all = await getAllFamilies();
      const sorted = all.sort(compareFamilies);
      const limited = sorted.slice(0, MAX_RETURNED);
      const congestion = computeCongestion(sorted, requesterId);
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(200).json({
        families: limited,
        congestion,
        total: sorted.length,
        timestamp: Date.now(),
        backend: KV_AVAILABLE ? "kv" : "memory"
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Internal error", message: String(err) });
  }
}
