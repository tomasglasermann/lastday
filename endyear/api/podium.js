// Live podium for the MTM End of Year Journey.
// Storage: in-memory Map kept on `globalThis` so state persists across
// invocations on the same warm function instance. For a multi-hour event with
// active traffic, the function instance generally stays warm; if a cold start
// happens, families simply re-appear in the leaderboard on their next stamp.

if (!globalThis.__mtmFamilies) {
  globalThis.__mtmFamilies = new Map();
}
const families = globalThis.__mtmFamilies;

const TOTAL_STATIONS = 20;
const MAX_NAME_LEN = 60;
const MAX_RETURNED = 200;

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function compareFamilies(a, b) {
  // Primary: more stamps first
  if (b.stamps !== a.stamps) return b.stamps - a.stamps;
  // Tie-break for completed: who finished first
  if (a.completedAt && b.completedAt) return a.completedAt - b.completedAt;
  if (a.completedAt) return -1;
  if (b.completedAt) return 1;
  // Tie-break for in-progress: most recent activity first
  return (b.lastUpdate || 0) - (a.lastUpdate || 0);
}

export default async function handler(req, res) {
  // Permissive CORS — same-origin in production, but flexible for testing
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

      const existing = families.get(id) || {};
      families.set(id, {
        id,
        name,
        stamps,
        startedAt: existing.startedAt || startedAt,
        completedAt: completedAt || existing.completedAt || null,
        lastUpdate: Date.now()
      });

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === "GET") {
      const list = Array.from(families.values()).sort(compareFamilies);
      const limited = list.slice(0, MAX_RETURNED);
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(200).json({
        families: limited,
        total: list.length,
        timestamp: Date.now()
      });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ error: "Internal error", message: String(err) });
  }
}
