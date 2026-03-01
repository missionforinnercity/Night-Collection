const MAPBOX_TOKEN = "pk.eyJ1IjoibWZpYzI1IiwiYSI6ImNtaGl6cjkzeTB3cHEya3F2NGg0bnZtcHgifQ.n_hXUOk7pbvFkf06XBvmcA";

const BAND_COLORS = {
  very_low: "#5f7cff",
  low: "#66d1ff",
  medium: "#caeb77",
  high: "#ffc979",
};

const BAND_META = {
  very_low: { label: "Very low", glow: "rgba(95,124,255,0.16)", core: "#5f7cff", outer: 10, inner: 6 },
  low: { label: "Low", glow: "rgba(102,209,255,0.18)", core: "#66d1ff", outer: 12, inner: 7 },
  medium: { label: "Medium", glow: "rgba(202,235,119,0.20)", core: "#caeb77", outer: 16, inner: 9 },
  high: { label: "High", glow: "rgba(255,201,121,0.25)", core: "#ffc979", outer: 20, inner: 11 },
};

const state = {
  data: [],
  filtered: [],
  q20: 0,
  q50: 0,
  q80: 0,
  maxTime: 0,
  viewMode: "follow",
  mapStyle: "dark",
  showPoints: true,
  map: null,
  currentMarker: null,
  startMarker: null,
  endMarker: null,
};

const els = {
  scrubber: document.getElementById("timeScrubber"),
  timeLabel: document.getElementById("timeLabel"),
  progressFill: document.getElementById("progressFill"),
  currentScore: document.getElementById("currentScore"),
  medianScore: document.getElementById("medianScore"),
  highScore: document.getElementById("highScore"),
  routeLengthValue: document.getElementById("routeLengthValue"),
  statusLabel: document.getElementById("statusLabel"),
  statusNote: document.getElementById("statusNote"),
  percentileRank: document.getElementById("percentileRank"),
  bandLegend: document.getElementById("bandLegend"),
  distributionChart: document.getElementById("distributionChart"),
  trendChart: document.getElementById("trendChart"),
  distributionMeta: document.getElementById("distributionMeta"),
  chartTooltip: document.getElementById("chartTooltip"),
  viewModeGroup: document.getElementById("viewModeGroup"),
  themeSwitch: document.getElementById("themeSwitch"),
  pointsToggle: document.getElementById("pointsToggle"),
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(",");
  return lines
    .map((line) => {
      const parts = line.split(",");
      const row = {};
      header.forEach((key, idx) => {
        row[key] = Number(parts[idx]);
      });
      return row;
    })
    .filter((row) => !Number.isNaN(row.time));
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] === undefined) {
    return sorted[base];
  }
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function brightnessBand(value) {
  if (value <= state.q20) return "very_low";
  if (value <= state.q50) return "low";
  if (value <= state.q80) return "medium";
  return "high";
}

function percentile(value) {
  const below = state.data.filter((row) => row.brightness <= value).length;
  return (below / state.data.length) * 100;
}

function gradientColor(value, min, max, alpha = 1) {
  const stops = [
    { p: 0.0, c: [95, 124, 255] },
    { p: 0.35, c: [102, 209, 255] },
    { p: 0.7, c: [202, 235, 119] },
    { p: 1.0, c: [255, 201, 121] },
  ];
  const ratio = max <= min ? 1 : clamp((value - min) / (max - min), 0, 1);
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i];
    const b = stops[i + 1];
    if (ratio <= b.p) {
      const t = (ratio - a.p) / (b.p - a.p || 1);
      const mixed = [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * t),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * t),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * t),
      ];
      return `rgba(${mixed[0]}, ${mixed[1]}, ${mixed[2]}, ${alpha})`;
    }
  }
  const last = stops[stops.length - 1].c;
  return `rgba(${last[0]}, ${last[1]}, ${last[2]}, ${alpha})`;
}

function pathFromPoints(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function computeBins(values, count) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min || 1) / count;
  const edges = Array.from({ length: count + 1 }, (_, i) => min + step * i);
  const centers = [];
  const counts = Array(count).fill(0);
  values.forEach((value) => {
    const idx = Math.min(count - 1, Math.floor((value - min) / (step || 1)));
    counts[idx] += 1;
  });
  for (let i = 0; i < count; i += 1) {
    centers.push((edges[i] + edges[i + 1]) / 2);
  }
  return { min, max, edges, centers, counts };
}

function createMarkerElement(className) {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

function currentMapStyleUrl() {
  return state.mapStyle === "satellite"
    ? "mapbox://styles/mapbox/satellite-streets-v12"
    : "mapbox://styles/mapbox/dark-v11";
}

function installMapLayers() {
  if (!state.map || state.map.getLayer("route-baseline")) return;

  state.map.addSource("route-baseline", {
    type: "geojson",
    data: {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: state.data.map((row) => [row.lon, row.lat]),
      },
    },
  });

  state.map.addLayer({
    id: "route-baseline",
    type: "line",
    source: "route-baseline",
    paint: {
      "line-color": "rgba(255,255,255,0.10)",
      "line-width": 2,
    },
  });

  Object.keys(BAND_META).forEach((band) => {
    state.map.addSource(`route-${band}`, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    state.map.addLayer({
      id: `route-${band}-glow`,
      type: "line",
      source: `route-${band}`,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": BAND_META[band].glow,
        "line-width": BAND_META[band].outer,
        "line-blur": 1.25,
      },
    });

    state.map.addLayer({
      id: `route-${band}-core`,
      type: "line",
      source: `route-${band}`,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": BAND_META[band].core,
        "line-width": BAND_META[band].inner,
        "line-opacity": 0.98,
      },
    });
  });

  state.map.addSource("sample-points", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  state.map.addLayer({
    id: "sample-points",
    type: "circle",
    source: "sample-points",
    paint: {
      "circle-radius": 4.5,
      "circle-color": ["get", "color"],
      "circle-opacity": 0.9,
      "circle-stroke-color": "rgba(255,255,255,0.25)",
      "circle-stroke-width": 1,
    },
  });

  state.map.on("mouseenter", "sample-points", () => {
    state.map.getCanvas().style.cursor = "pointer";
  });
  state.map.on("mouseleave", "sample-points", () => {
    state.map.getCanvas().style.cursor = "";
  });
  state.map.on("mousemove", "sample-points", (event) => {
    const feature = event.features && event.features[0];
    if (!feature) return;
    const props = feature.properties;
    const html = [
      `<strong>${props.bandLabel}</strong>`,
      `Time: ${Math.round(Number(props.time))}s`,
      `Brightness: ${Number(props.brightness).toFixed(1)} / 255`,
    ].join("<br>");
    if (state.popup) {
      state.popup.remove();
    }
    state.popup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
    })
      .setLngLat(event.lngLat)
      .setHTML(html)
      .addTo(state.map);
  });
  state.map.on("mouseleave", "sample-points", () => {
    if (state.popup) {
      state.popup.remove();
      state.popup = null;
    }
  });

  if (!state.currentMarker) {
    state.currentMarker = new mapboxgl.Marker({ element: createMarkerElement("current-marker") });
    state.startMarker = new mapboxgl.Marker({ element: createMarkerElement("start-marker") });
    state.endMarker = new mapboxgl.Marker({ element: createMarkerElement("end-marker") });
  }
}

function initMap() {
  mapboxgl.accessToken = MAPBOX_TOKEN;
  state.map = new mapboxgl.Map({
    container: "map",
    style: currentMapStyleUrl(),
    center: [state.data[0].lon, state.data[0].lat],
    zoom: 15.8,
    pitch: 20,
    bearing: -8,
    attributionControl: false,
  });

  state.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");

  state.map.on("load", () => {
    installMapLayers();
    updateMap();
  });
}

function setMapStyle(styleName) {
  state.mapStyle = styleName;
  if (!state.map) return;
  state.map.setStyle(currentMapStyleUrl());
  state.map.once("style.load", () => {
    installMapLayers();
    updateMap();
  });
}

function updateMap() {
  if (!state.map || !state.map.isStyleLoaded()) return;

  const filtered = state.filtered;
  const grouped = {
    very_low: [],
    low: [],
    medium: [],
    high: [],
  };

  for (let i = 0; i < filtered.length - 1; i += 1) {
    const a = filtered[i];
    const b = filtered[i + 1];
    const value = (a.brightness + b.brightness) / 2;
    const band = brightnessBand(value);
    grouped[band].push({
      type: "Feature",
      properties: { brightness: value },
      geometry: {
        type: "LineString",
        coordinates: [
          [a.lon, a.lat],
          [b.lon, b.lat],
        ],
      },
    });
  }

  Object.keys(grouped).forEach((band) => {
    const source = state.map.getSource(`route-${band}`);
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: grouped[band],
      });
    }
  });

  const pointsSource = state.map.getSource("sample-points");
  if (pointsSource) {
    pointsSource.setData({
      type: "FeatureCollection",
      features: state.showPoints
        ? filtered.map((row) => {
            const band = brightnessBand(row.brightness);
            return {
              type: "Feature",
              properties: {
                time: row.time,
                brightness: row.brightness,
                color: BAND_COLORS[band],
                bandLabel: BAND_META[band].label,
              },
              geometry: { type: "Point", coordinates: [row.lon, row.lat] },
            };
          })
        : [],
    });
  }

  const current = filtered[filtered.length - 1];
  const start = state.data[0];
  const end = state.data[state.data.length - 1];

  state.currentMarker.setLngLat([current.lon, current.lat]).addTo(state.map);
  state.startMarker.setLngLat([start.lon, start.lat]).addTo(state.map);
  state.endMarker.setLngLat([end.lon, end.lat]).addTo(state.map);

  if (state.viewMode === "follow") {
    state.map.easeTo({
      center: [current.lon, current.lat],
      zoom: 16.9,
      duration: 500,
      essential: true,
    });
  } else {
    const coords = filtered.map((row) => [row.lon, row.lat]);
    if (coords.length > 1) {
      const bounds = coords.reduce(
        (acc, coord) => acc.extend(coord),
        new mapboxgl.LngLatBounds(coords[0], coords[0]),
      );
      state.map.fitBounds(bounds, {
        padding: { top: 70, bottom: 70, left: 70, right: 70 },
        maxZoom: 16.2,
        duration: 500,
      });
    }
  }
}

function updateLegend() {
  const counts = { very_low: 0, low: 0, medium: 0, high: 0 };
  state.filtered.forEach((row) => {
    counts[brightnessBand(row.brightness)] += 1;
  });
  els.bandLegend.innerHTML = Object.keys(BAND_META)
    .map(
      (band) => `
        <span class="legend-chip">
          <span class="legend-dot" style="background:${BAND_META[band].core}; color:${BAND_META[band].core};"></span>
          ${BAND_META[band].label} (${counts[band] || 0})
        </span>
      `,
    )
    .join("");
}

function updateHero() {
  const current = state.filtered[state.filtered.length - 1];
  const rank = percentile(current.brightness);
  const status = brightnessBand(current.brightness);
  els.currentScore.textContent = current.brightness.toFixed(1);
  els.medianScore.textContent = state.q50.toFixed(1);
  els.highScore.textContent = state.q80.toFixed(1);
  els.routeLengthValue.textContent = `${Math.round(state.maxTime)}s`;
  els.percentileRank.textContent = `${Math.round(rank)}th`;
  els.statusLabel.textContent = BAND_META[status].label;
  els.statusNote.textContent =
    rank < 20
      ? "Current point sits in the dimmest zone of the route."
      : rank < 50
        ? "Current point is below the route midpoint."
        : rank < 80
          ? "Current point is in a healthy visibility band."
          : "Current point is among the brightest parts of the route.";
}

function updateScrubberUi() {
  const currentTime = Number(els.scrubber.value);
  const progress = state.maxTime <= 0 ? 0 : (currentTime / state.maxTime) * 100;
  els.progressFill.style.width = `${progress}%`;
  els.timeLabel.textContent = `${Math.round(currentTime)}s of ${Math.round(state.maxTime)}s`;
}

function renderDistributionChart() {
  const svg = els.distributionChart;
  const width = 620;
  const height = 280;
  const margin = { top: 18, right: 20, bottom: 28, left: 20 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const fullValues = state.data.map((row) => row.brightness);
  const currentValues = state.filtered.map((row) => row.brightness);
  const bins = 18;
  const full = computeBins(fullValues, bins);
  const curr = computeBins(currentValues, bins);
  const maxCount = Math.max(...full.counts, ...curr.counts, 1);
  const barW = plotW / bins;

  const linePoints = curr.counts.map((count, idx) => {
    const x = margin.left + idx * barW + barW / 2;
    const y = margin.top + plotH - (count / maxCount) * (plotH - 18);
    return [x, y];
  });
  const linePath = pathFromPoints(linePoints);
  const areaPath = `${linePath} L ${margin.left + plotW - barW / 2} ${margin.top + plotH} L ${margin.left + barW / 2} ${margin.top + plotH} Z`;

  const bars = curr.counts
    .map((count, idx) => {
      const x = margin.left + idx * barW + barW * 0.2;
      const h = (count / maxCount) * (plotH - 20);
      const y = margin.top + plotH - h;
      const center = curr.centers[idx];
      const color = gradientColor(center, curr.min, curr.max, 0.9);
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(barW * 0.6).toFixed(2)}" height="${h.toFixed(2)}" rx="10" fill="${color}" />`;
    })
    .join("");

  const backBars = full.counts
    .map((count, idx) => {
      const x = margin.left + idx * barW + barW * 0.08;
      const h = (count / maxCount) * (plotH - 14);
      const y = margin.top + plotH - h;
      const center = full.centers[idx];
      const color = gradientColor(center, full.min, full.max, 0.16);
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(barW * 0.84).toFixed(2)}" height="${h.toFixed(2)}" rx="12" fill="${color}" />`;
    })
    .join("");

  const current = state.filtered[state.filtered.length - 1];
  const currentX = margin.left + ((current.brightness - full.min) / (full.max - full.min || 1)) * plotW;

  svg.innerHTML = `
    <defs>
      <linearGradient id="distAreaGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="rgba(95,124,255,0.10)"></stop>
        <stop offset="35%" stop-color="rgba(102,209,255,0.12)"></stop>
        <stop offset="70%" stop-color="rgba(202,235,119,0.12)"></stop>
        <stop offset="100%" stop-color="rgba(255,201,121,0.10)"></stop>
      </linearGradient>
      <linearGradient id="distLineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#5f7cff"></stop>
        <stop offset="35%" stop-color="#66d1ff"></stop>
        <stop offset="70%" stop-color="#caeb77"></stop>
        <stop offset="100%" stop-color="#ffc979"></stop>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
    ${backBars}
    <path d="${areaPath}" fill="url(#distAreaGradient)"></path>
    ${bars}
    <path d="${linePath}" fill="none" stroke="url(#distLineGradient)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
    <line x1="${currentX.toFixed(2)}" x2="${currentX.toFixed(2)}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" stroke-dasharray="6 6"></line>
    <text x="${Math.min(width - 32, currentX + 8).toFixed(2)}" y="${(margin.top + 14).toFixed(2)}" fill="#eef4ff" font-size="11" font-weight="700">Now</text>
  `;

  const hoverZones = curr.centers
    .map((center, idx) => {
      const x = margin.left + idx * barW;
      return `<rect class="hover-zone" data-idx="${idx}" x="${x.toFixed(2)}" y="${margin.top}" width="${barW.toFixed(2)}" height="${plotH.toFixed(2)}" fill="transparent"></rect>`;
    })
    .join("");
  svg.insertAdjacentHTML("beforeend", hoverZones);

  const tooltip = els.chartTooltip;
  const zones = svg.querySelectorAll(".hover-zone");
  zones.forEach((zone) => {
    zone.addEventListener("mouseenter", (event) => {
      const idx = Number(event.target.getAttribute("data-idx"));
      const rangeStart = full.edges[idx];
      const rangeEnd = full.edges[idx + 1];
      tooltip.innerHTML = `
        <strong>${rangeStart.toFixed(1)}-${rangeEnd.toFixed(1)}</strong><br>
        Current route: ${curr.counts[idx]}<br>
        Full route: ${full.counts[idx]}
      `;
      tooltip.classList.remove("hidden");
      els.distributionMeta.textContent = `Hovering ${rangeStart.toFixed(1)}-${rangeEnd.toFixed(1)} brightness`;
    });
    zone.addEventListener("mousemove", (event) => {
      const rect = svg.getBoundingClientRect();
      tooltip.style.left = `${event.clientX - rect.left}px`;
      tooltip.style.top = `${event.clientY - rect.top}px`;
    });
    zone.addEventListener("mouseleave", () => {
      tooltip.classList.add("hidden");
      els.distributionMeta.textContent = "Hover to inspect bins";
    });
  });
}

function renderTrendChart() {
  const svg = els.trendChart;
  const width = 420;
  const height = 210;
  const margin = { top: 16, right: 16, bottom: 28, left: 18 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const minB = Math.min(...state.data.map((row) => row.brightness));
  const maxB = Math.max(...state.data.map((row) => row.brightness));
  const maxT = state.maxTime || 1;

  const toPoint = (row) => {
    const x = margin.left + (row.time / maxT) * plotW;
    const y = margin.top + plotH - ((row.brightness - minB) / (maxB - minB || 1)) * plotH;
    return [x, y];
  };

  const routePoints = state.data.map(toPoint);
  const currentPoints = state.filtered.map(toPoint);
  const routePath = pathFromPoints(routePoints);
  const currentPath = pathFromPoints(currentPoints);
  const current = currentPoints[currentPoints.length - 1];

  svg.innerHTML = `
    <defs>
      <linearGradient id="trendLineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#5f7cff"></stop>
        <stop offset="35%" stop-color="#66d1ff"></stop>
        <stop offset="70%" stop-color="#caeb77"></stop>
        <stop offset="100%" stop-color="#ffc979"></stop>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
    <path d="${routePath}" fill="none" stroke="rgba(167,181,209,0.22)" stroke-width="2"></path>
    <path d="${currentPath}" fill="none" stroke="url(#trendLineGradient)" stroke-width="3.5" stroke-linecap="round"></path>
    <circle cx="${current[0].toFixed(2)}" cy="${current[1].toFixed(2)}" r="7" fill="#ffffff" fill-opacity="0.2"></circle>
    <circle cx="${current[0].toFixed(2)}" cy="${current[1].toFixed(2)}" r="4.5" fill="#ffffff"></circle>
  `;
}

function updateUi() {
  const scrubTime = Number(els.scrubber.value);
  state.filtered = state.data.filter((row) => row.time <= scrubTime);
  updateScrubberUi();
  updateHero();
  updateLegend();
  renderDistributionChart();
  renderTrendChart();
  updateMap();
}

function bindControls() {
  els.scrubber.addEventListener("input", updateUi);

  els.viewModeGroup.addEventListener("click", (event) => {
    const button = event.target.closest(".toggle-button");
    if (!button) return;
    els.viewModeGroup.querySelectorAll(".toggle-button").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    state.viewMode = button.dataset.mode;
    updateMap();
  });

  els.themeSwitch.addEventListener("click", (event) => {
    const button = event.target.closest(".theme-chip");
    if (!button) return;
    els.themeSwitch.querySelectorAll(".theme-chip").forEach((node) => node.classList.remove("active"));
    button.classList.add("active");
    state.mapStyle = button.dataset.style;
    setMapStyle(state.mapStyle);
  });

  els.pointsToggle.addEventListener("change", (event) => {
    state.showPoints = event.target.checked;
    updateMap();
  });
}

async function bootstrap() {
  const response = await fetch("merged_route_data.csv");
  const csv = await response.text();
  state.data = parseCsv(csv);
  state.maxTime = Math.max(...state.data.map((row) => row.time));
  const brightness = state.data.map((row) => row.brightness);
  state.q20 = quantile(brightness, 0.2);
  state.q50 = quantile(brightness, 0.5);
  state.q80 = quantile(brightness, 0.8);

  els.scrubber.max = String(Math.round(state.maxTime));
  els.scrubber.value = "0";

  bindControls();
  state.filtered = state.data.filter((row) => row.time <= 0);
  initMap();
  updateUi();
}

bootstrap().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<pre style="padding:24px;color:#fff;background:#000">Failed to load dashboard: ${String(error)}</pre>`;
});
