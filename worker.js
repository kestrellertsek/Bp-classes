/**
 * Bouldering Project class schedule -> live iCal (.ics) feed
 * Cloudflare Worker. Paste this whole file into a new Worker in the Cloudflare
 * dashboard and deploy. It works with no settings (gym location 6, next 21 days).
 *
 * Optional settings (Worker -> Settings -> Variables and Secrets):
 *   LOCATION_IDS   Gym location number(s), comma-separated. Default "6".
 *   LOCATION_NAME  Text to show as the event location, e.g. "Bouldering Project Minneapolis".
 *   DAYS_AHEAD     How many days ahead to include. Default 21.
 *   TIMEZONE       Gym's time zone. Default America/Chicago.
 *   INCLUDE        Comma-separated words; keep only classes whose name, location or
 *                  description contains one. e.g. "yoga,intro"
 *   EXCLUDE        Comma-separated words to drop. e.g. "youth,team"
 *   CAL_NAME       Calendar name. Default "Bouldering Project Classes".
 *   API_KEY        Only if the public widget key below stops working.
 *   HEADER_MODE    Which request style to use: browser (default), browser_origin, minimal, bare_key.
 *
 * Subscribe URL: https://<your-worker>.workers.dev/classes.ics
 * Check pages:   /debug (classes found)  /raw (API's raw reply)  /test (tries each request style)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.origin + url.pathname, request);

    if (!["/debug", "/raw", "/test"].includes(url.pathname)) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }

    try {
      const tz = env.TIMEZONE || "America/Chicago";
      LOCATION_FALLBACK = env.LOCATION_NAME || "";
      const days = parseInt(env.DAYS_AHEAD || "21", 10);
      if (url.pathname === "/test") {
        const loc = (env.LOCATION_IDS || "6").split(",")[0].trim();
        const n = new Date();
        const q = new URLSearchParams({
          startDT: n.toISOString(),
          endDT: new Date(n.getTime() + 86400000).toISOString(),
          locationId: loc, page: "1", pageSize: "5",
        });
        const results = {};
        for (const [name, headers] of Object.entries(headerVariants(env, loc))) {
          try {
            const r = await fetch(`${API_BASE}?${q}`, { headers });
            results[name] = `${r.status} ${(await r.text()).slice(0, 150)}`;
          } catch (e) {
            results[name] = "error: " + e.message;
          }
        }
        return new Response(JSON.stringify(results, null, 2), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/raw") {
        const n = new Date();
        const data = await fetchPage(env, (env.LOCATION_IDS || "6").split(",")[0].trim(),
          n.toISOString(), new Date(n.getTime() + 2 * 86400000).toISOString(), 1);
        return new Response(JSON.stringify(data, null, 2).slice(0, 20000),
          { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const raw = await fetchSchedule(env, days);
      let events = extractEvents(raw);
      events = applyFilters(events, env.INCLUDE, env.EXCLUDE);

      if (url.pathname === "/debug") {
        return new Response(
          JSON.stringify({ count: events.length, sample: events.slice(0, 10) }, null, 2),
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      }

      const ics = buildICS(events, tz, env.CAL_NAME || "Bouldering Project Classes");
      const res = new Response(ics, {
        headers: {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'inline; filename="classes.ics"',
          "cache-control": "public, max-age=900", // 15 minutes
        },
      });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return new Response("Error building calendar: " + err.message, { status: 502 });
    }
  },
};

// ---------- Fetching ----------

// Approach's schedule widget reads from this API (found from the portal's network traffic).
const API_BASE = "https://widgets.api.prod.tilefive.com/cal";
const PORTAL = "https://boulderingproject.portal.approach.app";
const PUBLIC_WIDGET_KEY = "OQ2z4Q3jSU1BW3y9dyfEW5FlEFu1ozIj7jE27qjy"; // the key the public schedule page sends
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const CHUNK_DAYS = 7;

const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/158.0.8127.86 Mobile/15E148 Safari/604.1";

// Header sets to try, in order. "browser" copies the request the schedule page makes.
function headerVariants(env, locationId) {
  const base = {
    accept: "application/json, text/plain, */*",
    authorization: env.TENANT || "boulderingproject",
    "x-api-key": env.API_KEY || PUBLIC_WIDGET_KEY,
  };
  const referer = `${PORTAL}/schedule?scheduleView=week&locationIds=${locationId}`;
  return {
    browser: { ...base, "user-agent": BROWSER_UA, referer },
    browser_origin: { ...base, "user-agent": BROWSER_UA, referer, origin: PORTAL },
    minimal: { ...base },
    bare_key: { "x-api-key": env.API_KEY || PUBLIC_WIDGET_KEY },
  };
}

function apiHeaders(env, locationId) {
  const v = headerVariants(env, locationId);
  return v[env.HEADER_MODE || "browser"] || v.browser;
}

async function fetchPage(env, locationId, startISO, endISO, page) {
  const q = new URLSearchParams({
    startDT: startISO,
    endDT: endISO,
    locationId: String(locationId),
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  const r = await fetch(`${API_BASE}?${q}`, { headers: apiHeaders(env, locationId) });
  if (!r.ok) throw new Error(`Schedule request failed: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

function largestArrayLength(node) {
  let best = 0;
  (function walk(n) {
    if (Array.isArray(n)) { best = Math.max(best, n.length); n.forEach(walk); }
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  })(node);
  return best;
}

// Returns an array of raw page responses (extractEvents walks all of them).
async function fetchSchedule(env, days) {
  const locationIds = (env.LOCATION_IDS || "6").split(",").map((s) => s.trim()).filter(Boolean);
  const pages = [];
  const now = new Date();
  const from = new Date(now.getTime() - 86400000); // include yesterday so today's past classes stay
  const to = new Date(now.getTime() + days * 86400000);

  for (const loc of locationIds) {
    for (let s = from; s < to; s = new Date(s.getTime() + CHUNK_DAYS * 86400000)) {
      const e = new Date(Math.min(s.getTime() + CHUNK_DAYS * 86400000, to.getTime()) - 1);
      for (let p = 1; p <= MAX_PAGES; p++) {
        const data = await fetchPage(env, loc, s.toISOString(), e.toISOString(), p);
        pages.push(data);
        if (largestArrayLength(data) < PAGE_SIZE) break;
      }
    }
  }
  return pages;
}

// ---------- Finding the classes in the data ----------
// The exact shape of Approach's data isn't known yet, so this walks the JSON and
// picks out any object that looks like a class (has a start time and a name).

const START_KEYS = ["startDT", "startDt", "start_dt", "startDateTimeUtc", "start", "startTime", "start_time", "startsAt", "starts_at", "startDate", "start_date", "startDateTime", "begin"];
const END_KEYS = ["endDT", "endDt", "end_dt", "endDateTimeUtc", "end", "endTime", "end_time", "endsAt", "ends_at", "endDate", "end_date", "endDateTime", "finish"];
const NAME_KEYS = ["name", "title", "eventName", "classTitle", "className", "class_name", "eventName", "event_name", "activityName", "label"];
const LOC_KEYS = ["locationName", "location_name", "location", "facility", "facilityName", "gym", "room", "venue"];
const DESC_KEYS = ["description", "details", "summary", "notes"];
const STAFF_KEYS = ["instructor", "instructorName", "instructors", "staff", "staffName", "coach", "teacher"];
const ID_KEYS = ["id", "uuid", "eventId", "event_id", "sessionId", "session_id", "occurrenceId"];
const DUR_KEYS = ["duration", "durationMinutes", "duration_minutes", "length", "minutes"];
const SPOTS_KEYS = ["spotsRemaining", "spots_remaining", "available", "availableSpots", "remaining", "openSpots"];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(", ");
  if (typeof v === "object") {
    return textOf(pick(v, ["name", "title", "displayName", "fullName", "label"])) ||
      [v.firstName, v.lastName].filter(Boolean).join(" ");
  }
  return "";
}

let LOCATION_FALLBACK = "";

function extractEvents(data) {
  const out = [];
  const seen = new Set();

  (function walk(node, parent) {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, parent));
    if (!node || typeof node !== "object") return;

    const start = pick(node, START_KEYS);
    const name = textOf(pick(node, NAME_KEYS)) || textOf(parent && pick(parent, NAME_KEYS));
    if (start && name && parseDate(start)) {
      const ev = {
        id: String(pick(node, ID_KEYS) ?? ""),
        name,
        start,
        end: pick(node, END_KEYS),
        duration: pick(node, DUR_KEYS),
        location: textOf(pick(node, LOC_KEYS)) || textOf(parent && pick(parent, LOC_KEYS)) || LOCATION_FALLBACK,
        description: textOf(pick(node, DESC_KEYS)) || textOf(parent && pick(parent, DESC_KEYS)),
        instructor: textOf(pick(node, STAFF_KEYS)),
        spots: pick(node, SPOTS_KEYS),
        cancelled: Boolean(node.cancelled || node.canceled || node.isCancelled || node.isCanceled ||
          /cancel/i.test(String(node.status || ""))),
      };
      const key = ev.id || `${ev.name}|${ev.start}|${ev.location}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(ev);
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walk(v, node);
    }
  })(data, null);

  return out.sort((a, b) => parseDate(a.start).ms - parseDate(b.start).ms);
}

function applyFilters(events, include, exclude) {
  const list = (s) => (s || "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const inc = list(include);
  const exc = list(exclude);
  return events.filter((e) => {
    const hay = `${e.name} ${e.location} ${e.description}`.toLowerCase();
    if (inc.length && !inc.some((w) => hay.includes(w))) return false;
    if (exc.some((w) => hay.includes(w))) return false;
    return true;
  });
}

// ---------- Dates ----------
// Returns { ms, utc: bool, local: "YYYYMMDDTHHMMSS" }. Times with a zone (Z or +hh:mm)
// are written in UTC; times without one are treated as the gym's local time.

function parseDate(v) {
  if (typeof v === "number") {
    const ms = v < 1e12 ? v * 1000 : v;
    return { ms, utc: true };
  }
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s = "00", zone] = m;
  if (zone) return { ms: Date.parse(v.replace(" ", "T")), utc: true };
  return {
    ms: Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s), // for sorting/duration math only
    utc: false,
    local: `${Y}${Mo}${D}T${h}${mi}${s}`,
  };
}

function fmtUTC(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function fmtLocalFromMs(ms) {
  // ms here is the "fake UTC" value from a zone-less time
  return fmtUTC(ms).replace("Z", "");
}

function dtLine(prop, d, tz) {
  return d.utc ? `${prop}:${fmtUTC(d.ms)}` : `${prop};TZID=${tz}:${d.local}`;
}

// ---------- iCal output ----------

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function fold(line) {
  // iCal lines must be <= 75 octets; continuation lines start with a space.
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts = [];
  let cur = "";
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (curLen + len > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

function buildICS(events, tz, calName) {
  const now = fmtUTC(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//personal//bouldering-project-feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calName)}`,
    `X-WR-TIMEZONE:${tz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const e of events) {
    const s = parseDate(e.start);
    let en = e.end ? parseDate(e.end) : null;
    if (!en) {
      const mins = parseInt(e.duration, 10) || 60;
      const ms = s.ms + mins * 60000;
      en = s.utc ? { ms, utc: true } : { ms, utc: false, local: fmtLocalFromMs(ms) };
    }

    const descParts = [];
    if (e.instructor) descParts.push(`Instructor: ${e.instructor}`);
    if (e.spots !== undefined) descParts.push(`Spots left (at last check): ${e.spots}`);
    if (e.description) descParts.push(e.description.replace(/<[^>]+>/g, "").trim());

    const uidBase = e.id || `${e.name}-${e.start}-${e.location}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${esc(uidBase.replace(/[^\w.-]+/g, "-"))}@bp-feed`,
      `DTSTAMP:${now}`,
      dtLine("DTSTART", s, tz),
      dtLine("DTEND", en, tz),
      `SUMMARY:${esc((e.cancelled ? "CANCELLED: " : "") + e.name)}`
    );
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (descParts.length) lines.push(`DESCRIPTION:${esc(descParts.join("\n"))}`);
    if (e.cancelled) lines.push("STATUS:CANCELLED");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
