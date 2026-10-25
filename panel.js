/* Country info panel (top-left card).
 *
 * showCountry(label)  -> fills + reveals the card and starts the live updates
 * hideCountry()       -> hides the card and stops every timer / pending fetch
 *
 * Data sources (all free, no API key, CORS-enabled):
 *   REST Countries  - capital, area, languages, currency, flag ...
 *   World Bank      - population, birth/death rate, GDP, life expectancy ...
 *   Open-Meteo      - live weather, timezone, sunrise/sunset at the capital
 *   USGS            - earthquakes in the last 24 h
 *   open.er-api.com - currency exchange rate (cached for the session)
 *
 * "Live" numbers: the population is a running estimate (latest World Bank
 * figure projected forward with its recent growth rate) and ticks every second,
 * as do births/deaths today and the clock. Weather and earthquakes refresh
 * every 60 s.
 */

import { ISO3 } from "./isocodes.js";
import { COUNTRY_DATA } from "./countrydata.js";

const panel = document.getElementById("info");
const gridEl = document.getElementById("info-grid");
const nameEl = document.getElementById("info-name");
const subEl = document.getElementById("info-sub");
const flagEl = document.getElementById("info-flag");
const popEl = document.getElementById("info-pop");
const popSubEl = document.getElementById("info-popsub");

const YEAR_MS = 365.2425 * 86400000;
const YEAR_S = YEAR_MS / 1000;
const DASH = "—";

/* ---------- formatting ---------- */
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const pad = (n) => String(n).padStart(2, "0");
function dur(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    s = t % 60;
  return h ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  return `${Math.round(m / 6) / 10}h ago`;
}
function rateText(perSec) {
  if (!(perSec > 0)) return "";
  if (perSec >= 1) return `≈ ${nf1.format(perSec)} per second`;
  if (perSec * 60 >= 1) return `≈ ${nf1.format(perSec * 60)} per minute`;
  return `≈ ${nf1.format(perSec * 3600)} per hour`;
}

/* ---------- tiles ---------- */
// [id, label, options]   live = pulsing dot, wide = spans both columns,
// bump = brief flash when the value changes
const TILES = [
  ["weather", "Weather · capital", { live: true }],
  ["time", "Local time", { live: true }],
  ["births", "Births today", { live: true, bump: true }],
  ["deaths", "Deaths today", { live: true, bump: true }],
  ["quakes", "Earthquakes · 24h", { live: true, bump: true }],
  ["change", "Pop. change today", { live: true, bump: true }],
  ["sun", "Day / night", { live: true, wide: true }],
  ["capital", "Capital"],
  ["area", "Area"],
  ["density", "Density"],
  ["life", "Life expectancy"],
  ["gdp", "GDP"],
  ["gdppc", "GDP per capita"],
  ["internet", "Internet users"],
  ["urban", "Urban population"],
  ["call", "Calling code"],
  ["drive", "Drives on"],
  ["lang", "Languages", { wide: true }],
  ["cur", "Currency", { wide: true }],
];
const T = {};
for (const [id, label, o = {}] of TILES) {
  const el = document.createElement("div");
  el.className = "tile" + (o.wide ? " wide" : "");
  const k = document.createElement("div");
  k.className = "k" + (o.live ? " live" : "");
  k.textContent = label;
  const v = document.createElement("div");
  v.className = "v";
  if (o.bump) v.dataset.bump = "1";
  const s = document.createElement("div");
  s.className = "s";
  el.append(k, v, s);
  gridEl.appendChild(el);
  T[id] = { v, s };
}
popEl.dataset.bump = "1";

function put(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (el.dataset.bump) {
    el.classList.remove("bump");
    void el.offsetWidth; // restart the animation
    el.classList.add("bump");
  }
}
const tile = (id, v, s) => {
  put(T[id].v, v);
  if (s !== undefined) put(T[id].s, s);
};

/* ---------- clocks ---------- */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Clock for an IANA timezone (preferred) or a fixed UTC offset in minutes.
function makeClock({ tz, offsetMin = 0 }) {
  if (tz) {
    try {
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      let g = null;
      try {
        g = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          timeZoneName: "shortOffset",
        });
      } catch (_) {}
      return {
        parts(now) {
          const o = {};
          for (const p of f.formatToParts(now)) o[p.type] = p.value;
          const z = g
            ? (
                g.formatToParts(now).find((p) => p.type === "timeZoneName") ||
                {}
              ).value || ""
            : "";
          return {
            h: +o.hour % 24,
            m: +o.minute,
            s: +o.second,
            label: `${o.weekday} ${o.day} ${o.month}`,
            zone: z.replace("GMT", "UTC"),
          };
        },
      };
    } catch (_) {
      /* bad tz name -> fall through to fixed offset */
    }
  }
  const sign = offsetMin < 0 ? "-" : "+";
  const a = Math.abs(offsetMin);
  const zone = `UTC${sign}${Math.floor(a / 60)}${a % 60 ? ":" + pad(a % 60) : ""}`;
  return {
    parts(now) {
      const d = new Date(now + offsetMin * 60000);
      return {
        h: d.getUTCHours(),
        m: d.getUTCMinutes(),
        s: d.getUTCSeconds(),
        label: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
        zone,
      };
    },
  };
}

// Best-guess offset from REST Countries' "UTC+05:30" strings: the one closest
// to the capital's longitude (e.g. the USA lists UTC-12:00 first, which is wrong).
function guessOffsetMin(rc, lng) {
  const want = (lng / 15) * 60;
  let best = 0,
    bd = Infinity;
  for (const z of (rc && rc.timezones) || []) {
    const m = /UTC(?:([+-])(\d{1,2}):?(\d{2})?)?/.exec(z);
    if (!m) continue;
    const off = m[1]
      ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] || 0))
      : 0;
    const d = Math.abs(off - want);
    if (d < bd) {
      bd = d;
      best = off;
    }
  }
  return best;
}

/* ---------- weather codes (WMO) ---------- */
function wmo(code, isDay) {
  const day = isDay !== 0;
  if (code === 0) return [day ? "☀️" : "🌙", "Clear sky"];
  if (code === 1) return [day ? "🌤️" : "🌙", "Mainly clear"];
  if (code === 2) return ["⛅", "Partly cloudy"];
  if (code === 3) return ["☁️", "Overcast"];
  if (code === 45 || code === 48) return ["🌫️", "Fog"];
  if (code >= 51 && code <= 55) return ["🌦️", "Drizzle"];
  if (code === 56 || code === 57) return ["🌧️", "Freezing drizzle"];
  if (code >= 61 && code <= 65)
    return ["🌧️", ["Light rain", "Rain", "Heavy rain"][code - 61]];
  if (code === 66 || code === 67) return ["🌧️", "Freezing rain"];
  if (code >= 71 && code <= 75)
    return ["🌨️", ["Light snow", "Snow", "Heavy snow"][code - 71]];
  if (code === 77) return ["🌨️", "Snow grains"];
  if (code >= 80 && code <= 82) return ["🌦️", "Rain showers"];
  if (code === 85 || code === 86) return ["🌨️", "Snow showers"];
  if (code === 95) return ["⛈️", "Thunderstorm"];
  if (code === 96 || code === 99) return ["⛈️", "Thunderstorm with hail"];
  return ["🌡️", "Unknown"];
}

/* ---------- data fetching (cached per session) ---------- */
const rcCache = new Map();
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + " " + url);
  return r.json();
}
// Natural Earth entries with no numeric id
const NAME_ISO3 = { Kosovo: "XKX" };
const isoFor = (l) =>
  (l.id && ISO3[String(l.id).padStart(3, "0")]) || NAME_ISO3[l.name] || null;

// REST Countries is the richest source but may be down/blocked, so every
// failure falls back to the next source and finally to a minimal record.
function getCountry(l, iso3) {
  if (rcCache.has(l.name)) return rcCache.get(l.name);
  const p = (async () => {
    // World Bank country record (capital, coordinates, region)
    const rc = { cca3: iso3, latlng: [l.c[1], l.c[0]], partial: true };
    if (iso3) {
      try {
        const j = await getJSON(
          `https://api.worldbank.org/v2/country/${iso3}?format=json`,
        );
        const w = j && j[1] && j[1][0];
        if (w) {
          if (w.capitalCity) rc.capital = [w.capitalCity];
          if (w.latitude && w.longitude)
            rc.capitalInfo = { latlng: [+w.latitude, +w.longitude] };
          if (w.region && w.region.value && w.region.id !== "NA")
            rc.region = w.region.value;
          if (w.iso2Code)
            rc.flags = {
              svg: `https://flagcdn.com/${w.iso2Code.toLowerCase()}.svg`,
            };
        }
      } catch (e) {
        console.warn("[globe] World Bank country lookup failed", e.message);
      }
    }
    return rc;
  })();
  rcCache.set(l.name, p);
  return p;
}

const wbCache = new Map();
const WB = {
  pop: ["SP.POP.TOTL", 2],
  cbr: ["SP.DYN.CBRT.IN", 1],
  cdr: ["SP.DYN.CDRT.IN", 1],
  life: ["SP.DYN.LE00.IN", 1],
  gdp: ["NY.GDP.MKTP.CD", 1],
  gdppc: ["NY.GDP.PCAP.CD", 1],
  net: ["IT.NET.USER.ZS", 1],
  urb: ["SP.URB.TOTL.IN.ZS", 1],
  area: ["AG.SRF.TOTL.K2", 1],
};
// most recent non-empty value(s), newest first
function wbGet(code, key) {
  const ck = code + "|" + key;
  if (wbCache.has(ck)) return wbCache.get(ck);
  const [ind, n] = WB[key];
  const p = getJSON(
    `https://api.worldbank.org/v2/country/${code}/indicator/${ind}?format=json&mrnev=${n}`,
  )
    .then((j) =>
      (Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [])
        .filter((x) => x.value != null)
        .sort((a, b) => b.date - a.date),
    )
    .catch(() => {
      wbCache.delete(ck);
      return [];
    });
  wbCache.set(ck, p);
  return p;
}

let fxP = null;
function getFX() {
  if (!fxP)
    fxP = getJSON("https://open.er-api.com/v6/latest/USD")
      .then((j) => j.rates || null)
      .catch(() => {
        fxP = null;
        return null;
      });
  return fxP;
}

let quakeFeed = null; // { t, data }
async function getQuakes() {
  if (quakeFeed && Date.now() - quakeFeed.t < 55000) return quakeFeed.data;
  const data = await getJSON(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
  );
  quakeFeed = { t: Date.now(), data };
  return data;
}

/* ---------- state ---------- */
let state = null;

function stop(s) {
  if (!s) return;
  s.timers.forEach(clearInterval);
  s.timers.length = 0;
}

function resetUI(s) {
  nameEl.textContent = s.l.name;
  subEl.textContent = "";
  flagEl.hidden = true;
  flagEl.removeAttribute("src");
  put(popEl, DASH);
  put(popSubEl, "Loading…");
  for (const [id] of TILES) tile(id, "…", "");
}

export function showCountry(l) {
  stop(state);
  const s = (state = {
    l,
    rc: null,
    pop: null,
    cbr: null,
    cdr: null,
    clock: makeClock({ offsetMin: Math.round((l.c[0] / 15) * 60) }),
    tz: null,
    sunEvents: null,
    sunTxt: null,
    timers: [],
  });
  resetUI(s);
  panel.classList.remove("hidden");
  panel.scrollTop = 0;

  tick(s);
  s.timers.push(setInterval(() => tick(s), 1000));
  startQuakes(s);
  load(s);
}

export function hideCountry() {
  stop(state);
  state = null; // in-flight fetches see state !== s and drop their results
  panel.classList.add("hidden");
}

/* ---------- loading ---------- */
async function load(s) {
  const alive = () => state === s;
  const iso3 = isoFor(s.l);
  const rc = await getCountry(s.l, iso3);
  if (!alive()) return;
  s.rc = rc;
  renderStatic(s);

  const code = rc.cca3 === "UNK" ? "XKX" : rc.cca3;
  if (!code) {
    put(popSubEl, "Detailed data isn't available for this territory.");
    for (const [id] of TILES)
      if (T[id].v.textContent === "…") tile(id, DASH, "");
    return;
  }
  const latlng = (rc.capitalInfo && rc.capitalInfo.latlng) || rc.latlng;

  // clock fallback until Open-Meteo tells us the real timezone
  if (latlng && rc.timezones)
    s.clock = makeClock({ offsetMin: guessOffsetMin(rc, latlng[1]) });

  startWeather(s, latlng);

  // World Bank indicators (each fills its own tile as it arrives)
  const popP = wbGet(code, "pop");
  wbGet(code, "life").then((r) => {
    if (alive())
      tile(
        "life",
        r[0] ? nf1.format(r[0].value) + " yrs" : DASH,
        r[0] ? r[0].date + " estimate" : "",
      );
  });
  wbGet(code, "gdp").then((r) => {
    if (alive())
      tile(
        "gdp",
        r[0] ? money.format(r[0].value) : DASH,
        r[0] ? r[0].date + " · current US$" : "",
      );
  });
  wbGet(code, "gdppc").then((r) => {
    if (alive())
      tile(
        "gdppc",
        r[0] ? money.format(r[0].value) : DASH,
        r[0] ? r[0].date + " · per person" : "",
      );
  });
  wbGet(code, "net").then((r) => {
    if (alive())
      tile(
        "internet",
        r[0] ? nf1.format(r[0].value) + "%" : DASH,
        r[0] ? r[0].date + " · of population" : "",
      );
  });
  wbGet(code, "urb").then((r) => {
    if (alive())
      tile(
        "urban",
        r[0] ? nf1.format(r[0].value) + "%" : DASH,
        r[0] ? r[0].date + " · live in cities" : "",
      );
  });
  wbGet(code, "cbr").then((r) => {
    if (!alive()) return;
    s.cbr = r[0] ? r[0].value : false;
    tick(s);
  });
  wbGet(code, "cdr").then((r) => {
    if (!alive()) return;
    s.cdr = r[0] ? r[0].value : false;
    tick(s);
  });

  if (!rc.area)
    wbGet(code, "area").then((r) => {
      if (!alive() || !r[0]) return;
      rc.area = r[0].value;
      tile("area", nf0.format(rc.area) + " km²", "");
      tick(s);
    });

  getFX().then((rates) => {
    if (alive()) renderCurrency(s, rates);
  });

  // population needs the World Bank figure first, so there's no visible jump
  const popRows = await popP;
  if (!alive()) return;
  setupPop(s, popRows);
  tick(s);
}

function renderStatic(s) {
  const rc = s.rc;
  const region = [rc.subregion, rc.region].filter(Boolean);
  subEl.textContent = region.length
    ? region.join(" · ")
    : (rc.name && rc.name.official) || "";
  if (rc.flags && (rc.flags.svg || rc.flags.png)) {
    flagEl.onload = () => (flagEl.hidden = false);
    flagEl.onerror = () => (flagEl.hidden = true);
    flagEl.src = rc.flags.svg || rc.flags.png;
  }
  const cap = (rc.capital || []).slice(0, 2).join(", ");
  tile("capital", cap || DASH, rc.independent === false ? "Territory" : "");
  tile(
    "area",
    rc.area ? nf0.format(rc.area) + " km²" : DASH,
    rc.landlocked ? "Landlocked" : "",
  );
  const sd = COUNTRY_DATA[rc.cca3 === "UNK" ? "XKX" : rc.cca3] || {};
  const idd = rc.idd || {};
  const suf = idd.suffixes || [];
  const call =
    sd.call || (idd.root ? idd.root + (suf.length === 1 ? suf[0] : "") : "");
  tile("call", call || DASH, "");
  const side =
    sd.side ||
    (rc.car && rc.car.side
      ? rc.car.side[0].toUpperCase() + rc.car.side.slice(1)
      : "");
  tile("drive", side || DASH, "");
  const langs = sd.langs || Object.values(rc.languages || {});
  tile(
    "lang",
    langs.length
      ? langs.slice(0, 4).join(", ") +
          (langs.length > 4 ? ` +${langs.length - 4} more` : "")
      : DASH,
    "",
  );
  tile("cur", DASH, "");
  if (!rc.area) {
    tile("area", DASH, "");
    tile("density", DASH, "");
  }
  // provisional numbers until the live ones arrive
  put(popSubEl, "Loading live estimate…");
}

function renderCurrency(s, rates) {
  const rc = s.rc || {};
  const sd = COUNTRY_DATA[rc.cca3 === "UNK" ? "XKX" : rc.cca3] || {};
  let list = sd.cur; // [[code, name, symbol], ...]
  if (!list || !list.length)
    list = Object.entries(rc.currencies || {}).map(([c, v]) => [
      c,
      v.name || c,
      v.symbol || "",
    ]);
  if (!list.length) return tile("cur", DASH, "");
  const [c0, , sym0] = list[0];
  let sub = (sym0 && sym0 !== c0 ? sym0 + " · " : "") + c0;
  if (c0 === "USD") sub += " · reference currency";
  else if (rates && rates[c0])
    sub += ` · 1 USD = ${Number(rates[c0].toPrecision(4)).toLocaleString("en-US")} ${c0}`;
  tile(
    "cur",
    list
      .slice(0, 2)
      .map((x) => x[1])
      .join(", ") + (list.length > 2 ? ` +${list.length - 2}` : ""),
    sub,
  );
}

function setupPop(s, rows) {
  let base = s.rc && s.rc.population,
    t0 = Date.UTC(2024, 0, 1),
    g = 0,
    note = "UN estimate";
  if (rows && rows[0]) {
    base = rows[0].value;
    t0 = Date.UTC(+rows[0].date, 6, 1); // World Bank = mid-year figures
    note = `World Bank ${rows[0].date}`;
    if (rows[1]) {
      const dy = rows[0].date - rows[1].date;
      if (dy > 0) g = Math.log(rows[0].value / rows[1].value) / dy;
    }
  }
  if (!base) {
    put(popSubEl, "Population data unavailable");
    return;
  }
  s.pop = { base, t0, g };
  const pct = g * 100;
  s.popNote = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% per year · based on ${note}`;
}

// "+3 per second" / "+1 person every 12 min"
function netText(perSec) {
  const a = Math.abs(perSec);
  if (!(a > 0)) return "";
  const sg = perSec < 0 ? "−" : "+";
  if (a >= 1) return `${sg}${nf1.format(a)} per second`;
  const sec = 1 / a;
  if (sec < 120) return `${sg}1 person every ${Math.round(sec)}s`;
  if (sec < 7200) return `${sg}1 person every ${Math.round(sec / 60)} min`;
  return `${sg}1 person every ${nf1.format(sec / 3600)} h`;
}

const popAt = (p, t) => p.base * Math.exp((p.g * (t - p.t0)) / YEAR_MS);

/* ---------- live ticking (every second) ---------- */
function tick(s) {
  if (state !== s) return;
  const now = Date.now();
  const c = s.clock.parts(now);
  tile(
    "time",
    `${pad(c.h)}:${pad(c.m)}:${pad(c.s)}`,
    c.label + (c.zone ? " · " + c.zone : ""),
  );

  if (s.pop) {
    const pn = popAt(s.pop, now);
    put(popEl, nf0.format(Math.floor(pn)));
    put(popSubEl, `Live · ${netText((pn * s.pop.g) / YEAR_S)} · ${s.popNote}`);

    // seconds since local midnight in the country
    const sinceMid = c.h * 3600 + c.m * 60 + c.s + (now % 1000) / 1000;
    const change = pn - popAt(s.pop, now - sinceMid * 1000);
    tile(
      "change",
      (change >= 0 ? "+" : "−") +
        (Math.abs(change) < 10
          ? nf1.format(Math.abs(change))
          : nf0.format(Math.abs(change))),
      "people since midnight (net)",
    );
    if (s.rc && s.rc.area) {
      const d = pn / s.rc.area;
      tile(
        "density",
        (d < 100 ? nf1.format(d) : nf0.format(d)) + " /km²",
        "people per km²",
      );
    }
    if (s.cbr) {
      const perSec = (pn * s.cbr) / 1000 / YEAR_S;
      tile(
        "births",
        nf0.format(Math.floor(perSec * sinceMid)),
        rateText(perSec),
      );
    } else if (s.cbr === false) tile("births", DASH, "");
    if (s.cdr) {
      const perSec = (pn * s.cdr) / 1000 / YEAR_S;
      tile(
        "deaths",
        nf0.format(Math.floor(perSec * sinceMid)),
        rateText(perSec),
      );
    } else if (s.cdr === false) tile("deaths", DASH, "");
  }
  updateSun(s, now);
}

function updateSun(s, now) {
  if (!s.sunEvents) return;
  const next = s.sunEvents.find((e) => e.t > now);
  if (!next) return tile("sun", DASH, "No sunrise or sunset today");
  const day = next.type === "sunset";
  tile(
    "sun",
    (day ? "☀️ Daytime · sunset in " : "🌙 Night · sunrise in ") +
      dur(next.t - now),
    s.sunTxt ? `Sunrise ${s.sunTxt.rise} · Sunset ${s.sunTxt.set} (local)` : "",
  );
}

/* ---------- weather + timezone + sun (every 60 s) ---------- */
function startWeather(s, latlng) {
  if (!latlng) {
    tile("weather", DASH, "No location");
    return;
  }
  const go = async () => {
    try {
      const j = await getJSON(
        "https://api.open-meteo.com/v1/forecast" +
          `?latitude=${latlng[0]}&longitude=${latlng[1]}` +
          "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day" +
          "&daily=sunrise,sunset&timezone=auto&forecast_days=2&wind_speed_unit=kmh",
      );
      if (state !== s) return;
      applyWeather(s, j);
    } catch (_) {
      if (state !== s) return;
      if (T.weather.v.textContent === "…")
        tile("weather", DASH, "Weather unavailable");
    }
  };
  go();
  s.timers.push(setInterval(go, 60000));
}

function applyWeather(s, j) {
  const cur = j.current || {};
  const [icon, text] = wmo(cur.weather_code, cur.is_day);
  tile(
    "weather",
    `${icon} ${Math.round(cur.temperature_2m)}°C`,
    `${text} · feels ${Math.round(cur.apparent_temperature)}° · ${Math.round(cur.relative_humidity_2m)}% humidity · wind ${Math.round(cur.wind_speed_10m)} km/h`,
  );
  if (j.timezone && j.timezone !== s.tz) {
    s.tz = j.timezone;
    s.clock = makeClock({
      tz: j.timezone,
      offsetMin: Math.round((j.utc_offset_seconds || 0) / 60),
    });
  }
  const off = j.utc_offset_seconds || 0;
  const parse = (str) => {
    const m = /(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(str || "");
    return m
      ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 1000
      : null;
  };
  const d = j.daily || {};
  const ev = [];
  for (let i = 0; i < 2; i++) {
    const r = parse(d.sunrise && d.sunrise[i]),
      t = parse(d.sunset && d.sunset[i]);
    if (r) ev.push({ t: r, type: "sunrise" });
    if (t) ev.push({ t, type: "sunset" });
  }
  ev.sort((a, b) => a.t - b.t);
  s.sunEvents = ev;
  s.sunTxt = {
    rise: d.sunrise && d.sunrise[0] ? d.sunrise[0].slice(11, 16) : DASH,
    set: d.sunset && d.sunset[0] ? d.sunset[0].slice(11, 16) : DASH,
  };
  if (!ev.length) tile("sun", DASH, "No sunrise or sunset today");
  tick(s);
}

/* ---------- earthquakes (every 60 s) ---------- */
function startQuakes(s) {
  const go = async () => {
    try {
      const feed = await getQuakes();
      if (state !== s) return;
      const hits = feed.features.filter(
        (q) =>
          q.geometry &&
          d3.geoContains(s.l.feat, [
            q.geometry.coordinates[0],
            q.geometry.coordinates[1],
          ]),
      );
      if (!hits.length) return tile("quakes", "0", "None in the last 24 h");
      const big = hits.reduce((a, b) =>
        (b.properties.mag || 0) > (a.properties.mag || 0) ? b : a,
      );
      tile(
        "quakes",
        String(hits.length),
        `Largest M${(big.properties.mag || 0).toFixed(1)} · ${ago(Date.now() - big.properties.time)}`,
      );
    } catch (_) {
      if (state !== s) return;
      if (T.quakes.v.textContent === "…")
        tile("quakes", DASH, "Feed unavailable");
    }
  };
  go();
  s.timers.push(setInterval(go, 60000));
}
