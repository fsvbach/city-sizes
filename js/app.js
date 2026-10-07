// js/app.js
//
// City Comparison: loads city boundaries via Nominatim (polygon_geojson),
// projects each city into local meters around its area centroid, and overlays
// all outlines true to scale on a common anchor point.
//
// Depends on: Leaflet (L in global scope)

// ══════════════════════════════════════════════════════════════════════════════
// 1 · CONFIG
// ══════════════════════════════════════════════════════════════════════════════

// Comparison loaded on startup. To change the default, Save an arrangement
// and point this at the file.
const DEFAULT_COMPARISON_URL = 'data/zurich-2.json';

// Anchor all cities are centered on — the centroid of the reference city
// (set by placeAround, switchable via the radio buttons in the panel).
let anchor = null;
let referenceId = null;   // OSM id (e.g. "relation/62422") of the reference city

// Legend (city panel) mode, set by the header buttons: 'full' (colors, sizes,
// controls, tooltips), 'names' (visible cities' names only — for quizzes), 'off'
const LEGEND_MODES = ['full', 'names', 'off'];
let legendMode = 'full';

const PALETTE = ['#e74c3c', '#27ae60', '#2980b9', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#2c3e50'];

const M_PER_DEG = 111320;               // meters per degree of latitude (approx.)
const CACHE_TTL = 7 * 24 * 3600 * 1000; // cache Nominatim responses for 7 days


// ══════════════════════════════════════════════════════════════════════════════
// 2 · MAP
// ══════════════════════════════════════════════════════════════════════════════
const map = L.map('map', {
  zoomControl: false,
  // Quarter zoom steps for buttons, keyboard, and scroll wheel
  zoomSnap: 0.25,
  zoomDelta: 0.25,
});
map.fitWorld();  // placeholder view until the default comparison is loaded
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

// Muted greyscale tiles so the colored outlines stand out.
// CARTO Positron needs a (free) key since Sep 2026, configured per host in js/config.js.
// Without a key for this host, fall back to Esri's key-free Light Gray Canvas (max zoom 16).
const CARTO_API_KEY = ((window.CARTO_API_KEYS || {})[location.hostname] || '').trim();
const BOUNDARY_ATTRIBUTION = 'Boundaries: <a href="https://nominatim.org/">Nominatim</a>';

if (CARTO_API_KEY) {
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=' +
      encodeURIComponent(CARTO_API_KEY),
    {
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '© <a href="https://carto.com/attributions">CARTO</a> · ' + BOUNDARY_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 19,
    }
  ).addTo(map);
} else {
  console.warn(`No CARTO key for host "${location.hostname}" in js/config.js — using Esri Light Gray fallback (max zoom 16).`);
  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    {
      attribution:
        'Tiles © <a href="https://www.esri.com/">Esri</a> — Esri, HERE, Garmin, ' +
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ' +
        BOUNDARY_ATTRIBUTION,
      maxZoom: 16,
    }
  ).addTo(map);
}


// ══════════════════════════════════════════════════════════════════════════════
// 3 · GEOMETRY
// ══════════════════════════════════════════════════════════════════════════════

/** Normalizes Polygon/MultiPolygon to MultiPolygon coordinates. */
function toMultiPolygon(geojson) {
  if (geojson.type === 'MultiPolygon') return geojson.coordinates;
  if (geojson.type === 'Polygon')      return [geojson.coordinates];
  throw new Error(`Unexpected geometry type: ${geojson.type}`);
}

/** Signed area + centroid of a ring (shoelace), in input units. */
function ringAreaCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a /= 2;
  if (!a) return { area: 0, cx: ring[0][0], cy: ring[0][1] };
  return { area: a, cx: cx / (6 * a), cy: cy / (6 * a) };
}

/** Area & centroid of one polygon (outer ring positive, holes negative). */
function polygonStats(poly) {
  let area = 0, cx = 0, cy = 0;
  poly.forEach((ring, i) => {
    const r = ringAreaCentroid(ring);
    const w = (i === 0 ? 1 : -1) * Math.abs(r.area);
    area += w;
    cx += r.cx * w;
    cy += r.cy * w;
  });
  return { area, cx: cx / (area || 1), cy: cy / (area || 1) };
}

/**
 * Projects a city into local meters (equirectangular around its first vertex),
 * drops outlying islands/exclaves, shifts the rest so its area centroid sits
 * at the origin, and computes area and extent.
 *
 * Returns: { polysM, centroid, areaKm2, widthKm, heightKm, excludedParts }
 */
function projectCity(multi) {
  const [lon0, lat0] = multi[0][0][0];
  const cos0 = Math.cos(lat0 * Math.PI / 180);

  let polysM = multi.map(poly => poly.map(ring => ring.map(([lon, lat]) => [
    (lon - lon0) * cos0 * M_PER_DEG,
    (lat - lat0) * M_PER_DEG,
  ])));

  // Drop outlying parts (islands/exclaves) that would badly bias centroid and
  // extent — e.g. Hamburg's Neuwerk (117 km away) or Tokyo's island chains
  // (up to 1,900 km) — while keeping legitimate city islands like New York's
  // boroughs (≤ 9 km apart) together. A part is dropped when its centroid is
  //   · farther from the largest polygon's centroid than 3× that polygon's
  //     equivalent radius, or
  //   · a tiny fragment (< 2 % of the main area) beyond 1× that radius
  // (both with a 20 km floor, so compact cities never lose nearby parts).
  const parts = polysM.map(polygonStats);
  const main = parts.reduce((a, b) => (b.area > a.area ? b : a));
  const rMain = Math.sqrt(main.area / Math.PI);
  const hardLimit = Math.max(3 * rMain, 20000);
  const nearLimit = Math.max(rMain, 20000);
  const kept = polysM.filter((_, i) => {
    const d = Math.hypot(parts[i].cx - main.cx, parts[i].cy - main.cy);
    if (d > hardLimit) return false;
    if (parts[i].area < 0.02 * main.area && d > nearLimit) return false;
    return true;
  });
  const excludedParts = polysM.length - kept.length;
  polysM = kept;

  // Total area & centroid: outer rings count positive, holes negative
  let areaSum = 0, cxSum = 0, cySum = 0;
  for (const poly of polysM) {
    const { area, cx, cy } = polygonStats(poly);
    areaSum += area;
    cxSum += cx * area;
    cySum += cy * area;
  }
  const cX = cxSum / areaSum;
  const cY = cySum / areaSum;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const poly of polysM) {
    for (const ring of poly) {
      for (const pt of ring) {
        pt[0] -= cX;
        pt[1] -= cY;
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      }
    }
  }

  return {
    polysM,
    centroid: [lat0 + cY / M_PER_DEG, lon0 + cX / (cos0 * M_PER_DEG)],
    areaKm2:  areaSum / 1e6,
    widthKm:  (maxX - minX) / 1000,
    heightKm: (maxY - minY) / 1000,
    excludedParts,
  };
}

/** Converts meter coordinates (centroid = origin) around the anchor into
 *  LatLngs, optionally shifted by an offset [dx, dy] in meters. */
function toAnchorLatLngs(polysM, offsetM = [0, 0]) {
  const cosA = Math.cos(anchor[0] * Math.PI / 180);
  const [dx, dy] = offsetM;
  return polysM.map(poly => poly.map(ring => ring.map(([x, y]) => [
    anchor[0] + (y + dy) / M_PER_DEG,
    anchor[1] + (x + dx) / (M_PER_DEG * cosA),
  ])));
}


// ══════════════════════════════════════════════════════════════════════════════
// 4 · NOMINATIM
// ══════════════════════════════════════════════════════════════════════════════
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOMINATIM_OPTS = '&format=jsonv2&polygon_geojson=1&polygon_threshold=0.0005&accept-language=en';

// localStorage cache with TTL
function cacheGet(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  } catch { /* broken cache entry → refetch */ }
  return null;
}
function cachePut(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { /* full */ }
}

// OSM ids: the app uses "relation/62422", Nominatim's lookup endpoint "R62422"
const toLookupId   = id => id.replace(/^relation\//, 'R').replace(/^way\//, 'W').replace(/^node\//, 'N');
const fromLookupId = id => ({ R: 'relation/', W: 'way/', N: 'node/' })[id[0]] + id.slice(1);

/** Boundary data from a Nominatim result (search and lookup share the format). */
function boundaryFromHit(hit) {
  return {
    osmId: `${hit.osm_type}/${hit.osm_id}`,
    // Resolved official name (first component of display_name) instead of
    // whatever the user typed — makes wrong matches visible immediately
    name: hit.display_name.split(',')[0].trim(),
    displayName: hit.display_name,
    geojson: hit.geojson,
  };
}

async function fetchBoundary(query) {
  const key = `cityBoundary:v2:${query}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const r = await fetch(`${NOMINATIM}/search?q=${encodeURIComponent(query)}&limit=1${NOMINATIM_OPTS}`);
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);

  const hit = (await r.json())[0];
  if (!hit?.geojson || !hit.geojson.type.includes('Polygon')) {
    throw new Error(`No boundary found for “${query}”`);
  }

  const data = boundaryFromHit(hit);
  cachePut(key, data);
  cachePut(`cityBoundary:v2:id:${toLookupId(data.osmId)}`, data);  // lets share links skip the lookup
  return data;
}

/** Boundaries for several OSM ids ("R62422", …) via lookup requests of up to
 *  50 ids. Returns a Map lookupId → data; unknown ids are missing from it. */
async function fetchBoundariesByIds(lookupIds) {
  const found = new Map();
  const missing = [];
  for (const id of lookupIds) {
    const cached = cacheGet(`cityBoundary:v2:id:${id}`);
    if (cached) found.set(id, cached); else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 50) {
    const r = await fetch(`${NOMINATIM}/lookup?osm_ids=${missing.slice(i, i + 50).join(',')}${NOMINATIM_OPTS}`);
    if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
    for (const hit of await r.json()) {
      if (!hit.geojson?.type.includes('Polygon')) continue;
      const data = boundaryFromHit(hit);
      const id = toLookupId(data.osmId);
      cachePut(`cityBoundary:v2:id:${id}`, data);
      found.set(id, data);
    }
  }
  return found;
}


// ══════════════════════════════════════════════════════════════════════════════
// 5 · CITIES
// ══════════════════════════════════════════════════════════════════════════════
const cities = [];  // { id, label, displayName, geojson, color, offsetM, visible,
                    //   polysM, centroid, areaKm2, widthKm, heightKm, excludedParts, polygon }

/** Creates a city (projection + Leaflet polygon, placed by placeAround) from
 *  boundary data with optional color, offset and visibility. */
function createCity({ osmId, name, displayName, geojson, color = PALETTE[cities.length % PALETTE.length],
                      offsetM = [0, 0], visible = true }) {
  const { polysM, centroid, areaKm2, widthKm, heightKm, excludedParts } =
    projectCity(toMultiPolygon(geojson));
  const polygon = L.polygon([], {
    color, weight: 2.5, fillColor: color, fillOpacity: 0.12,
    // Don't let clicks on the outline bubble to the map — map.on('click')
    // would clear the selection right away
    bubblingMouseEvents: false,
  });
  if (visible) polygon.addTo(map);
  const city = { id: osmId, label: name, displayName, geojson, color, offsetM, visible,
                 polysM, centroid, areaKm2, widthKm, heightKm, excludedParts, polygon };
  cities.push(city);
  attachInteraction(city);
  return city;
}

/** Sets the reference (first city as fallback) and places all outlines around
 *  its centroid with their offsets. */
function placeAround(refId) {
  const ref = cities.find(c => c.id === refId) || cities[0];
  referenceId = ref.id;
  anchor = ref.centroid;
  for (const c of cities) c.polygon.setLatLngs(toAnchorLatLngs(c.polysM, c.offsetM));
}

/** Makes a city the reference location: the whole arrangement shifts rigidly
 *  so its outline coincides with its real boundary on the map, all other
 *  cities keep their position relative to it (manual drags included). */
function setReference(id) {
  const ref = cities.find(c => c.id === id);
  if (!ref) return;
  const [dx, dy] = ref.offsetM;
  for (const c of cities) c.offsetM = [c.offsetM[0] - dx, c.offsetM[1] - dy];
  placeAround(id);
  fitVisible();
  refresh();
}

async function addCity(query) {
  const data = await fetchBoundary(query);
  if (cities.some(c => c.id === data.osmId)) throw new Error(`“${data.name}” is already on the map`);
  const city = createCity(data);
  placeAround(referenceId);
  refresh();
  return city;
}

// ── Derived state: layer order, tooltips, panel ──────────────────────────────

/** Largest city at the bottom, smallest on top — otherwise Berlin hides Norderstedt. */
function restackLayers() {
  [...cities].sort((a, b) => b.areaKm2 - a.areaKm2)
    .forEach(c => { if (c.visible) c.polygon.bringToFront(); });
}

function formatKm2(v) {
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
}

function tooltipHtml(c) {
  return `<b>${c.label}</b><br>` +
    `${formatKm2(c.areaKm2)} km²<br>` +
    `Extent: ${Math.round(c.widthKm)} × ${Math.round(c.heightKm)} km` +
    (c.excludedParts
      ? `<br><i>${c.excludedParts} outlying part${c.excludedParts > 1 ? 's' : ''} excluded</i>`
      : '');
}

/** Tooltips reveal name and size, so they exist only in the full legend mode. */
function syncTooltip(city) {
  if (legendMode === 'full') {
    if (!city.polygon.getTooltip()) city.polygon.bindTooltip(tooltipHtml(city), { sticky: true });
  } else {
    city.polygon.unbindTooltip();
  }
}

/** Re-syncs everything derived from the cities and the legend mode. Called
 *  once at the end of each operation that changes them. */
function refresh() {
  restackLayers();
  for (const c of cities) syncTooltip(c);
  cityPanel.render();
}

// ── View ─────────────────────────────────────────────────────────────────────

/** fitBounds that survives a running zoom animation (Leaflet silently drops
 *  fitBounds/setView calls during one — Map._tryAnimatedZoom returns early). */
let pendingFit = null;

function fitBoundsSafe(bounds, padding = [30, 30]) {
  if (map._animatingZoom) {
    if (!pendingFit) {
      map.once('zoomend', () => {
        const { bounds, padding } = pendingFit;
        pendingFit = null;
        map.fitBounds(bounds, { padding });
      });
    }
    pendingFit = { bounds, padding };
  } else {
    map.fitBounds(bounds, { padding });
  }
}

/** Zooms the map to all visible cities. */
function fitVisible() {
  const visible = cities.filter(c => c.visible);
  if (!visible.length) return;
  fitBoundsSafe(visible.reduce((b, c) => b.extend(c.polygon.getBounds()), L.latLngBounds([])));
}

// ── Selection & moving ───────────────────────────────────────────────────────
// First click on an outline selects the city; while selected it can be dragged
// with the mouse. Clicking it again clears the selection.
let selectedId = null;
let lastDragEnd = 0;

function setSelected(id) {
  selectedId = id;
  for (const c of cities) {
    const sel = c.id === id;
    c.polygon.setStyle({ weight: sel ? 4.5 : 2.5, fillOpacity: sel ? 0.18 : 0.12 });
    const el = c.polygon.getElement();
    if (el) el.style.cursor = sel ? 'grab' : '';
  }
}

function attachInteraction(city) {
  const { polygon } = city;

  polygon.on('click', () => {
    // The click that ends a drag must not toggle the selection
    if (performance.now() - lastDragEnd < 200) return;
    setSelected(selectedId === city.id ? null : city.id);
  });

  polygon.on('mousedown', e => {
    if (selectedId !== city.id) return;  // not selected → map pans normally
    L.DomEvent.preventDefault(e.originalEvent);
    map.dragging.disable();

    const startLatLng = e.latlng;
    const startPoint  = e.containerPoint;
    const base = [...city.offsetM];
    const cosA = Math.cos(anchor[0] * Math.PI / 180);
    const el = polygon.getElement();
    if (el) el.style.cursor = 'grabbing';
    let moved = false;

    const onMove = ev => {
      if (ev.containerPoint.distanceTo(startPoint) > 3) moved = true;
      city.offsetM = [
        base[0] + (ev.latlng.lng - startLatLng.lng) * M_PER_DEG * cosA,
        base[1] + (ev.latlng.lat - startLatLng.lat) * M_PER_DEG,
      ];
      polygon.setLatLngs(toAnchorLatLngs(city.polysM, city.offsetM));
    };
    const onUp = () => {
      map.off('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      map.dragging.enable();
      if (el) el.style.cursor = 'grab';
      if (moved) lastDragEnd = performance.now();
    };
    map.on('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Clicking the empty map clears the selection
map.on('click', () => setSelected(null));


// ══════════════════════════════════════════════════════════════════════════════
// 6 · LOAD / SAVE / SHARE
// ══════════════════════════════════════════════════════════════════════════════
// Two formats, both without hidden cities and both loaded via loadComparison:
// a self-contained JSON file (geometry included, loads without Nominatim) and
// a URL hash with only ids, colors, offsets, reference, legend mode and map
// section (boundaries are fetched again on opening; names-only legend → quiz).
//   #cities=R1682248:e74c3c:0:0,R65606:2980b9:-1200:340&ref=R1682248
//    &legend=names&view=47.1,8.2,47.6,9.0      (view: south,west,north,east)

/** Replaces the current comparison. entries: boundary data + color/offsetM/visible. */
function loadComparison({ entries, referenceId: refId, legendMode: mode = legendMode, view = null }) {
  for (const c of cities) c.polygon.remove();
  cities.length = 0;
  selectedId = null;
  for (const e of entries) createCity(e);
  placeAround(refId);
  setLegendMode(mode);  // includes refresh()
  if (view) fitBoundsSafe(L.latLngBounds(view), [0, 0]); else fitVisible();
}

function importComparison(data) {
  if (data?.format !== 'city-comparison/1' || !Array.isArray(data.cities) || !data.cities.length) {
    throw new Error('Not a city-comparison file');
  }
  loadComparison({
    entries: data.cities.map(c => ({ osmId: c.id, name: c.label, displayName: c.displayName, geojson: c.geojson,
                                     color: c.color, offsetM: c.offsetM, visible: c.visible })),
    referenceId: data.referenceId,
  });
  setStatus(`Loaded ${cities.length} cities`);
}

function exportComparison() {
  const visibleCities = cities.filter(c => c.visible);
  if (!visibleCities.length) { setStatus('No visible cities to save'); return; }
  const data = {
    format: 'city-comparison/1',
    exported: new Date().toISOString(),
    referenceId,
    cities: visibleCities.map(c => ({
      id: c.id, label: c.label, displayName: c.displayName,
      color: c.color, offsetM: c.offsetM,
      geojson: c.geojson,
    })),
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `city-comparison-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Comparison saved');
}

function buildShareHash() {
  const b = map.getBounds();
  const f = v => v.toFixed(4);
  return 'cities=' + cities.filter(c => c.visible).map(c =>
      `${toLookupId(c.id)}:${c.color.slice(1)}:${Math.round(c.offsetM[0])}:${Math.round(c.offsetM[1])}`
    ).join(',')
    + `&ref=${toLookupId(referenceId)}`
    + `&legend=${legendMode}`
    + `&view=${f(b.getSouth())},${f(b.getWest())},${f(b.getNorth())},${f(b.getEast())}`;
}

/** Parses a share hash; null if there is none. */
function parseShareHash(hash) {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (!p.has('cities')) return null;
  const entries = p.get('cities').split(',').map(s => {
    const [lookupId, color, dx, dy] = s.split(':');
    return { lookupId, color: `#${color}`, offsetM: [Number(dx) || 0, Number(dy) || 0] };
  }).filter(e => /^[RWN]\d+$/.test(e.lookupId) && /^#[0-9a-f]{6}$/i.test(e.color));
  if (!entries.length) return null;
  const view = (p.get('view') || '').split(',').map(Number);
  const ref = p.get('ref') || '';
  return {
    entries,
    referenceId: /^[RWN]\d+$/.test(ref) ? fromLookupId(ref) : null,
    legendMode: LEGEND_MODES.includes(p.get('legend')) ? p.get('legend') : 'full',
    view: view.length === 4 && view.every(Number.isFinite) ? [[view[0], view[1]], [view[2], view[3]]] : null,
  };
}

async function importSharedView(shared) {
  setStatus('Loading shared comparison…');
  const boundaries = await fetchBoundariesByIds(shared.entries.map(e => e.lookupId));
  const entries = shared.entries.filter(e => boundaries.has(e.lookupId))
    .map(e => ({ ...boundaries.get(e.lookupId), color: e.color, offsetM: e.offsetM }));
  if (!entries.length) throw new Error('none of the linked cities was found');
  loadComparison({ entries, referenceId: shared.referenceId, legendMode: shared.legendMode, view: shared.view });
  const missing = shared.entries.length - entries.length;
  setStatus(`Loaded ${entries.length} cities` + (missing ? ` (${missing} not found)` : ''));
}


// ══════════════════════════════════════════════════════════════════════════════
// 7 · CITY PANEL (Leaflet control, top right)
// ══════════════════════════════════════════════════════════════════════════════
const CityPanel = L.Control.extend({
  options: { position: 'topright' },

  onAdd() {
    this._div = L.DomUtil.create('div', 'city-panel');
    L.DomEvent.disableClickPropagation(this._div);
    L.DomEvent.disableScrollPropagation(this._div);
    this.render();
    return this._div;
  },

  render() {
    if (!this._div) return;
    this._div.style.display = legendMode === 'off' ? 'none' : '';
    if (legendMode === 'off') return;

    if (legendMode === 'names') {
      // Visible cities' names only, alphabetically — area order, colors, the
      // bold reference and hidden-city rows would all give the answer away
      const names = cities.filter(c => c.visible)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(c => `<div class="city-row"><span class="city-name">${c.label}</span></div>`)
        .join('');
      this._div.innerHTML = `
        <strong>Cities</strong>
        ${names || '<div class="city-empty">No city visible</div>'}`;
      return;
    }

    const rows = [...cities].sort((a, b) => b.areaKm2 - a.areaKm2).map(c => `
      <div class="city-row${c.id === referenceId ? ' is-ref' : ''}">
        <input type="radio" name="refCity" data-id="${c.id}"
               title="Use as reference location" ${c.id === referenceId ? 'checked' : ''} />
        <input type="checkbox" data-id="${c.id}"
               title="Show/hide" ${c.visible ? 'checked' : ''} />
        <input type="color" class="swatch" data-id="${c.id}" value="${c.color}"
               title="Change color" />
        <span class="city-name" title="${c.displayName}">${c.label}</span>
        <span class="city-area">${formatKm2(c.areaKm2)} km²</span>
      </div>`).join('');

    this._div.innerHTML = `
      <strong>Cities</strong>
      ${rows || '<div class="city-empty">No city loaded yet</div>'}
      ${rows ? `<div class="panel-hint">◉ reference location on the map · ☑ visible<br>
        Move a city: click its outline, then drag</div>` : ''}
      <form id="addCityForm">
        <input id="addCityInput" type="text" placeholder="Add a city…" autocomplete="off" />
      </form>`;

    // 'click' instead of 'change': clicking the already active reference fires
    // no change event, but should still re-align it with the map in case it
    // was dragged away
    this._div.querySelectorAll('input[type="radio"]').forEach(rb => {
      rb.addEventListener('click', () => setReference(rb.dataset.id));
    });

    // Live color picking: update the polygon while the picker is open
    this._div.querySelectorAll('input[type="color"]').forEach(ci => {
      ci.addEventListener('input', () => {
        const city = cities.find(c => c.id === ci.dataset.id);
        city.color = ci.value;
        city.polygon.setStyle({ color: ci.value, fillColor: ci.value });
      });
    });

    this._div.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const city = cities.find(c => c.id === cb.dataset.id);
        city.visible = cb.checked;
        if (cb.checked) { city.polygon.addTo(map); restackLayers(); }
        else {
          city.polygon.remove();
          if (selectedId === city.id) setSelected(null);
        }
      });
    });

    this._div.querySelector('#addCityForm').addEventListener('submit', async e => {
      e.preventDefault();
      const input = this._div.querySelector('#addCityInput');
      const query = input.value.trim();
      if (!query) return;
      // No label-based duplicate check here: different queries can resolve to
      // the same name but different OSM objects. addCity dedups by OSM id.
      input.disabled = true;
      setStatus(`Loading ${query}…`);
      try {
        const city = await addCity(query);
        setStatus(`Added ${city.label}`);
      } catch (err) {
        console.error(err);
        setStatus(err.message);
        input.disabled = false;
      }
    });
  },
});

const cityPanel = new CityPanel();
map.addControl(cityPanel);


// ══════════════════════════════════════════════════════════════════════════════
// 8 · HEADER
// ══════════════════════════════════════════════════════════════════════════════
const legendButtons = [...document.querySelectorAll('.legend-modes button')];

function setLegendMode(mode) {
  legendMode = LEGEND_MODES.includes(mode) ? mode : 'full';
  for (const b of legendButtons) {
    const active = b.dataset.mode === legendMode;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  refresh();
}
legendButtons.forEach(b => b.addEventListener('click', () => setLegendMode(b.dataset.mode)));

const copyLinkBtn = document.getElementById('copyLinkBtn');
copyLinkBtn.addEventListener('click', async () => {
  if (!cities.some(c => c.visible)) { setStatus('No visible cities to share'); return; }
  history.replaceState(null, '', `#${buildShareHash()}`);  // link also shows in the address bar
  const label = copyLinkBtn.querySelector('span');
  try {
    await navigator.clipboard.writeText(location.href);
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy link'; }, 2000);
  } catch {
    setStatus('Clipboard blocked — copy the link from the address bar');
  }
});

document.getElementById('saveBtn').addEventListener('click', exportComparison);

const importInput = document.getElementById('importFile');
document.getElementById('loadBtn').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  try {
    importComparison(JSON.parse(await file.text()));
  } catch (err) {
    console.error(err);
    setStatus(`Import failed: ${err.message}`);
  }
  importInput.value = '';
});

function setStatus(text) {
  document.getElementById('status').textContent = text;
}


// ══════════════════════════════════════════════════════════════════════════════
// 9 · INITIAL LOAD
// ══════════════════════════════════════════════════════════════════════════════
// A share link in the URL takes precedence over the default comparison.
(async () => {
  const shared = parseShareHash(location.hash);
  try {
    if (shared) { await importSharedView(shared); return; }
    const r = await fetch(DEFAULT_COMPARISON_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    importComparison(await r.json());
  } catch (err) {
    // Reading the default file fails on file:// (browsers block local fetch);
    // the Load button works regardless.
    console.error(err);
    setStatus(shared
      ? `Could not load the link: ${err.message}`
      : 'Could not load the default comparison — serve the app over HTTP or use Load');
  }
})();
