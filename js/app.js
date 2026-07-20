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

// Anchor all cities are centered on — the centroid of the reference city,
// set as soon as the first city is instantiated and switchable via the
// radio buttons in the panel.
let anchor = null;
let referenceId = null;   // OSM id (e.g. "relation/62422") of the reference city

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

// Muted greyscale tiles so the colored outlines stand out
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '© <a href="https://carto.com/attributions">CARTO</a> · ' +
    'Boundaries: <a href="https://nominatim.org/">Nominatim</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);


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
async function fetchBoundary(query) {
  const key = `cityBoundary:v2:${query}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.ts < CACHE_TTL) return { ...cached.data, fromCache: true };
  } catch { /* broken cache entry → refetch */ }

  const url = 'https://nominatim.openstreetmap.org/search'
    + `?q=${encodeURIComponent(query)}`
    + '&format=jsonv2&polygon_geojson=1&polygon_threshold=0.0005&limit=1'
    + '&accept-language=en';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);

  const hit = (await r.json())[0];
  if (!hit?.geojson || !hit.geojson.type.includes('Polygon')) {
    throw new Error(`No boundary found for “${query}”`);
  }

  const data = {
    osmId: `${hit.osm_type}/${hit.osm_id}`,
    // Resolved official name (first component of display_name) instead of
    // whatever the user typed — makes wrong matches visible immediately
    name: hit.display_name.split(',')[0].trim(),
    displayName: hit.display_name,
    geojson: hit.geojson,
  };
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { /* full */ }
  return { ...data, fromCache: false };
}


// ══════════════════════════════════════════════════════════════════════════════
// 5 · CITY LAYERS
// ══════════════════════════════════════════════════════════════════════════════
const cities = [];  // { id, label, displayName, color, areaKm2, widthKm, heightKm,
                    //   polysM, centroid, polygon, visible, offsetM }

function formatKm2(v) {
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
}

/** Largest city at the bottom, smallest on top — otherwise Berlin hides Norderstedt. */
function restackLayers() {
  [...cities].sort((a, b) => b.areaKm2 - a.areaKm2)
    .forEach(c => { if (c.visible) c.polygon.bringToFront(); });
}

/** Zooms the map to all visible cities. If a zoom animation is in flight the
 *  fit is deferred to zoomend — Leaflet silently swallows fitBounds/setView
 *  calls made during one (Map._tryAnimatedZoom returns early). */
let pendingFitBounds = null;

function fitVisible() {
  const visible = cities.filter(c => c.visible);
  if (!visible.length) return;
  const bounds = visible.reduce((b, c) => b.extend(c.polygon.getBounds()), L.latLngBounds([]));
  if (map._animatingZoom) {
    if (!pendingFitBounds) {
      map.once('zoomend', () => {
        const b = pendingFitBounds;
        pendingFitBounds = null;
        map.fitBounds(b, { padding: [30, 30] });
      });
    }
    pendingFitBounds = bounds;
  } else {
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

/** Makes a city the reference location. The assembled arrangement is kept:
 *  the whole group shifts rigidly so the new reference outline coincides with
 *  its real boundary on the map — all other cities keep their position
 *  relative to it (manual drags included). */
function setReference(id) {
  const city = cities.find(c => c.id === id);
  if (!city) return;
  referenceId = id;
  anchor = city.centroid;
  const [dx, dy] = city.offsetM;
  for (const c of cities) {
    c.offsetM = [c.offsetM[0] - dx, c.offsetM[1] - dy];
    c.polygon.setLatLngs(toAnchorLatLngs(c.polysM, c.offsetM));
  }
  restackLayers();
  fitVisible();
  cityPanel.render();
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

/** Builds a city (projection, polygon, tooltip, panel entry) from boundary
 *  data — either freshly fetched (addCity) or restored from a saved file
 *  (importComparison, which passes color/visibility/offset via opts). */
function instantiateCity({ osmId, name, displayName, geojson }, opts = {}) {
  const color   = opts.color ?? PALETTE[cities.length % PALETTE.length];
  const offsetM = opts.offsetM ?? [0, 0];
  const { polysM, centroid, areaKm2, widthKm, heightKm, excludedParts } =
    projectCity(toMultiPolygon(geojson));

  // The first loaded city automatically becomes the reference location
  if (!cities.length) {
    referenceId = osmId;
    anchor = centroid;
  }

  const polygon = L.polygon(toAnchorLatLngs(polysM, offsetM), {
    color,
    weight: 2.5,
    fillColor: color,
    fillOpacity: 0.12,
    // Don't let clicks on the outline bubble to the map — map.on('click')
    // would clear the selection right away
    bubblingMouseEvents: false,
  });
  if (opts.visible !== false) polygon.addTo(map);

  polygon.bindTooltip(
    `<b>${name}</b><br>` +
    `${formatKm2(areaKm2)} km²<br>` +
    `Extent: ${Math.round(widthKm)} × ${Math.round(heightKm)} km` +
    (excludedParts
      ? `<br><i>${excludedParts} outlying part${excludedParts > 1 ? 's' : ''} excluded</i>`
      : ''),
    { sticky: true },
  );

  const city = { id: osmId, label: name, displayName, color, areaKm2, widthKm, heightKm,
                 polysM, centroid, polygon, geojson,
                 visible: opts.visible !== false, offsetM };
  cities.push(city);
  attachInteraction(city);
  restackLayers();
  cityPanel.render();
  return city;
}

async function addCity(query) {
  const { fromCache, ...data } = await fetchBoundary(query);
  if (cities.some(c => c.id === data.osmId)) {
    throw new Error(`“${data.name}” is already on the map`);
  }
  const city = instantiateCity(data);
  return { label: city.label, fromCache };
}


// ══════════════════════════════════════════════════════════════════════════════
// 6 · SAVE / LOAD
// ══════════════════════════════════════════════════════════════════════════════
// Comparisons are exported as self-contained JSON (boundary geometry included),
// so loading reproduces the exact arrangement without any Nominatim requests.
// Hidden cities are left out of the file.

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

function importComparison(data) {
  if (data?.format !== 'city-comparison/1' || !Array.isArray(data.cities) || !data.cities.length) {
    throw new Error('Not a city-comparison file');
  }

  // Replace the current comparison
  for (const c of cities) c.polygon.remove();
  cities.length = 0;
  selectedId = null;
  referenceId = null;

  for (const c of data.cities) {
    instantiateCity(
      { osmId: c.id, name: c.label, displayName: c.displayName, geojson: c.geojson },
      { color: c.color, visible: c.visible, offsetM: c.offsetM },
    );
  }

  // Restore the reference and re-place all outlines around it, keeping the
  // saved manual offsets (setReference would reset them)
  const ref = cities.find(c => c.id === data.referenceId) || cities[0];
  referenceId = ref.id;
  anchor = ref.centroid;
  for (const c of cities) c.polygon.setLatLngs(toAnchorLatLngs(c.polysM, c.offsetM));
  restackLayers();
  fitVisible();
  cityPanel.render();
  setStatus(`Loaded ${cities.length} cities`);
}

// Header buttons (static DOM — wired up once)
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
        const { label } = await addCity(query);
        setStatus(`Added ${label}`);
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

function setStatus(text) {
  document.getElementById('status').textContent = text;
}


// ══════════════════════════════════════════════════════════════════════════════
// 8 · INITIAL LOAD
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    const r = await fetch(DEFAULT_COMPARISON_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    importComparison(await r.json());
  } catch (err) {
    // Reading the default file fails on file:// (browsers block local fetch);
    // the Load button works regardless.
    console.error(err);
    setStatus('Could not load the default comparison — serve the app over HTTP or use Load');
  }
})();
