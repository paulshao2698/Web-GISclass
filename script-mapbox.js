// ─── Global State ───────────────────────────────────────────────────────────────

let map;
let buildingData = null;
let agentData = null;
let streetCornerData = null;
let hotspotData = null;
let loadingTimer = null;
let loadingProgress = 0;
let currentPopup = null;
let animation = null;
let currentTime = 0;
let tripsData = null;
let isPlaying = true;
let deckgl = null;
let loopLength = 0;
let animationSpeed = 10;
let minTimestamp = 0;

const SF_CENTER    = [-122.4194, 37.7749];
const DEFAULT_ZOOM = 13;
const MAPBOX_TOKEN = "pk.eyJ1IjoicGF1bDI2OTgiLCJhIjoiY205bGdzdTdvMDRxbDJqcTd3aGVkcnZ1dSJ9.8eDSkNsHW9K25GU2UN1zrw";

const BUILDINGS_LAYER_ID         = 'buildings-layer';
const BUILDINGS_CLUSTER_LAYER_ID = 'buildings-cluster-layer';
const HEATMAP_LAYER_ID           = 'heatmap-layer';
const AGENT_PATHS_LAYER_ID       = 'agent-paths-layer';
const HOTSPOTS_LAYER_ID          = 'hotspots-layer';
const TOP5_LAYER_ID              = 'top5-layer';
const TOP5_LABELS_LAYER_ID       = 'top5-labels-layer';

// ─── Initialization ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initApp);

function initApp() {
  try {
    document.getElementById('retry-button').onclick = useFallbackData;
    initializeMap();
    setupControls();
    startLoadingProgress();

    setTimeout(() => {
      if (document.getElementById('loading').style.display !== 'none') {
        console.warn('Timeout → using sample data');
        useFallbackData();
      }
    }, 15000);

  } catch (err) {
    console.error("initApp error:", err);
    document.getElementById('map-error').style.display = 'block';
    hideLoading();
  }
}

function initializeMap() {
  try {
    if (!window.mapboxgl) throw new Error("Mapbox GL not found");
    mapboxgl.accessToken = MAPBOX_TOKEN;

    map = new mapboxgl.Map({
      container: 'map',
      style:     'mapbox://styles/mapbox/streets-v11',
      center:    SF_CENTER,
      zoom:      DEFAULT_ZOOM,
      maxZoom:   18,
      minZoom:   10
    });

    map.on('load', () => {
      document.getElementById('map-error').style.display = 'none';
      loadData();
    });

  } catch (err) {
    console.error("initializeMap error:", err);
    const el = document.getElementById('map-error');
    el.innerHTML = `<div>Error initializing map: ${err.message}</div>`;
    el.style.display = 'block';
  }
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'retry-button') {
    document.getElementById('map-error').style.display = 'none';
    if (map) map.remove();
    initializeMap();
  }
});

// ─── UI Controls ────────────────────────────────────────────────────────────────

function setupControls() {
  const slider        = document.getElementById('time-slider');
  const display       = document.getElementById('time-value');
  const autoUpdate    = document.getElementById('auto-update');
  const showBuildings = document.getElementById('show-buildings');
  const showClusters  = document.getElementById('show-clusters');
  const showHeatmap   = document.getElementById('show-heatmap');
  const showHotspots  = document.getElementById('show-hotspots');
  const showPaths     = document.getElementById('show-agent-paths');
  const top5Btn       = document.getElementById('show-top5-btn');

  // 1) Time slider + auto-update
  slider.addEventListener('input', () => {
    const secs = +slider.value;
    display.textContent = formatTime(secs);
    if (autoUpdate.checked) updateMapForTime(secs);
  });
  top5Btn.onclick = () => updateMapForTime(+slider.value);

  // 2) Show/hide individual building points
  showBuildings.onchange = () => {
    toggleLayerVisibility(BUILDINGS_LAYER_ID, showBuildings.checked);
  };

  // 3) Show/hide building clusters (separate toggle)
  showClusters.onchange = () => {
    const on = showClusters.checked;
    toggleLayerVisibility(BUILDINGS_CLUSTER_LAYER_ID, on);
    toggleLayerVisibility('cluster-count',            on);
  };

  // 4) Show/hide heatmap layer
  showHeatmap.onchange = () => {
    toggleLayerVisibility(HEATMAP_LAYER_ID, showHeatmap.checked);
  };

  // 5) Show/hide agent-path hotspots
  showHotspots.onchange = () => {
    const on = showHotspots.checked;
    // clustered hotspots
    toggleLayerVisibility('hotspot-clusters',     on);
    toggleLayerVisibility('hotspot-labels',       on);
    // single-point hotspots
    toggleLayerVisibility(HOTSPOTS_LAYER_ID,      on);
    toggleLayerVisibility('hotspot-point-labels', on);
  };

  // 6) Show/hide & animate agent paths
  showPaths.onchange = () => {
    const deckCon = document.getElementById('deckgl-container');
    deckCon.style.display = showPaths.checked ? 'block' : 'none';
    isPlaying = showPaths.checked;
    if (isPlaying) animate();
  };
}

// Utility to toggle any layer by ID
function toggleLayerVisibility(layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

// Human-friendly HH:MM formatter
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

// ─── Data Loading ──────────────────────────────────────────────────────────────

function loadData() {
  updateLoadingProgress(10);

  const bldFetch = fetch('building_occupancy_max_people.geojson')
    .then(r => { updateLoadingProgress(20); if (!r.ok) throw 0; return r.json(); })
    .catch(() => fetch('building_occupancy_sf_5k.json')
      .then(r => { updateLoadingProgress(25); if (!r.ok) throw 0; return r.json(); })
    );

  const tripFetch = fetch('trips_sf_5k.json')
    .then(r => { updateLoadingProgress(50); if (!r.ok) throw 0; return r.json(); });

  Promise.all([bldFetch, tripFetch])
    .then(([bData, aData]) => {
      updateLoadingProgress(70);
      buildingData = bData;
      agentData    = aData;
      addBuildingsToMap();
      processAgentData();
      generateStreetCorners();

      // defer Deck.GL initialization until style is loaded
      if (map.isStyleLoaded()) {
        initializeTripsAnimation();
      } else {
        map.once('style.load', initializeTripsAnimation);
      }

      const t = +document.getElementById('time-slider').value;
      updateMapForTime(t);

      updateLoadingProgress(100);
      hideLoading();
    })
    .catch(err => {
      console.warn('Real data load failed, falling back:', err);
      useFallbackData();
    });
}

function useFallbackData() {
  console.log('Using sample data as fallback');
  generateStreetCorners();
  initializeTripsAnimation();
  hideLoading();
  showError('Using sample data (real data could not be loaded)');
}

// ─── Deck.GL Trips Animation ──────────────────────────────────────────────────

function initializeTripsAnimation() {
  if (!agentData || !map) return;
  let container = document.getElementById('deckgl-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'deckgl-container';
    document.getElementById('map-container').appendChild(container);
  }

  deckgl = new deck.DeckGL({
    container: 'deckgl-container',
    map: map,
    initialViewState: {
      longitude: SF_CENTER[0],
      latitude: SF_CENTER[1],
      zoom: DEFAULT_ZOOM,
      pitch: 30,
      bearing: 0
    },
    controller: false
  });

  prepareTripsData();
  animate();
}

function prepareTripsData() {
  const validAgents = (agentData || []).filter(a =>
    a.path?.length > 1 &&
    Array.isArray(a.timestamps) &&
    a.path.length === a.timestamps.length
  );
  if (!validAgents.length) return;

  const allT = validAgents.flatMap(a => a.timestamps);
  minTimestamp  = Math.min(...allT);
  const maxTime = Math.max(...allT);
  loopLength    = maxTime - minTimestamp;

  const counts = {};
  validAgents.forEach(a => {
    const key = `${a.place_from}-${a.place_to}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  const maxCount = Math.max(...Object.values(counts), 1);

  tripsData = validAgents.map(a => {
    const key = `${a.place_from}-${a.place_to}`;
    const pop = counts[key] / maxCount;
    return {
      path: a.path.map(c => [...c, 0]),
      timestamps: a.timestamps.map(t => t - minTimestamp),
      agent_id: a.agent_id,
      place_from: a.place_from,
      place_to: a.place_to,
      routePopularity: pop,
      color: getHeatMapColor(pop)
    };
  });

  const slider = document.getElementById('time-slider');
  if (slider) { slider.min = 0; slider.max = loopLength; slider.value = 0; }
  currentTime = 0;
  updateTripsVisualization(0);
}

function animate() {
  if (!isPlaying || !deckOverlay || !tripsData) return;
  currentTime = (currentTime + animationSpeed) % loopLength;
  updateTripsVisualization(currentTime);
  animation = requestAnimationFrame(animate);
}

function updateTripsVisualization(time) {
  const slider  = document.getElementById('time-slider');
  const display = document.getElementById('time-value');
  if (slider)  slider.value = time;
  if (display) display.textContent = formatTime(time + minTimestamp);

  const layer = new deck.TripsLayer({
    id: 'trips-layer',
    data: tripsData,
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: d => d.color,
    getWidth: d => 3 + d.routePopularity * 5,
    widthMinPixels: 2,
    widthMaxPixels: 8,
    opacity: 0.85,
    rounded: true,
    fadeTrail: true,
    trailLength: 200,
    currentTime: time,
    pickable: true,
    onHover: info => {
      closeCurrentPopup();
      if (info.object) {
        currentPopup = new mapboxgl.Popup({ closeButton: false, offset: 10 })
          .setLngLat(info.coordinate)
          .setHTML(`
            <div style="padding:8px">
              <strong>Agent ${info.object.agent_id}</strong><br>
              From: ${info.object.place_from}<br>
              To: ${info.object.place_to}
            </div>
          `)
          .addTo(map);
      }
    }
  });

  deckgl.setProps({ layers: [layer] });
}

// ─── Building & Heatmap ─────────────────────────────────────────────────────────

function addBuildingsToMap() {
  const processed = {
    type: 'FeatureCollection',
    features: (buildingData?.features || []).map(f => {
      const nf = JSON.parse(JSON.stringify(f));
      if (!nf.properties.max_people && Array.isArray(nf.properties.people)) {
        nf.properties.max_people = Math.max(...nf.properties.people.filter(x => !isNaN(x)));
      }
      return nf;
    })
  };

  if (!map.getSource('buildings-source')) {
    map.addSource('buildings-source', {
      type: 'geojson', data: processed, cluster: true, clusterMaxZoom: 14, clusterRadius: 50
    });
    map.addLayer({
      id: BUILDINGS_LAYER_ID,
      type: 'circle',
      source: 'buildings-source',
      filter: ['!', ['has','point_count']],
      paint: {
        'circle-radius': ['interpolate',['linear'],['get','max_people'],0,3,100,5,500,8,1000,10],
        'circle-color':  ['interpolate',['linear'],['get','max_people'],0,'#BBDEFB',100,'#64B5F6',500,'#2196F3',1000,'#1976D2'],
        'circle-opacity': 0.7
      }
    });
    map.addLayer({
      id: BUILDINGS_CLUSTER_LAYER_ID,
      type: 'circle',
      source: 'buildings-source',
      filter: ['has','point_count'],
      paint: {
        'circle-color':  ['step',['get','point_count'],'#51bbd6',100,'#f1f075',750,'#f28cb1'],
        'circle-radius': ['step',['get','point_count'],20,100,30,750,40]
      }
    });
    map.addLayer({
      id: 'cluster-count',
      type: 'symbol',
      source: 'buildings-source',
      filter: ['has','point_count'],
      layout: {'text-field':'{point_count_abbreviated}','text-size':12}
    });
  } else {
    map.getSource('buildings-source').setData(processed);
  }

  if (!map.getLayer(HEATMAP_LAYER_ID)) {
    map.addLayer({
      id: HEATMAP_LAYER_ID,
      type: 'heatmap',
      source: 'buildings-source',
      maxzoom: 15,
      paint: {
        'heatmap-weight':     ['interpolate',['linear'],['get','max_people'],0,0,100,0.2,500,0.6,1000,1],
        'heatmap-intensity':  ['interpolate',['linear'],['zoom'],10,1,15,3],
        'heatmap-color':      ['interpolate',['linear'],['heatmap-density'],
                                 0,'rgba(0,0,255,0)',
                                 0.2,'rgba(0,0,255,0.5)',
                                 0.4,'rgba(0,255,255,0.5)',
                                 0.6,'rgba(0,255,0,0.5)',
                                 0.8,'rgba(255,255,0,0.5)',
                                 1,'rgba(255,0,0,0.5)'
                              ],
        'heatmap-radius':     ['interpolate',['linear'],['zoom'],10,20,15,40],
        'heatmap-opacity':    0.7
      }
    });
  }

  // show the legend for the heatmap
  if (!document.querySelector('.heat-map-legend')) {
    const legend = document.createElement('div');
    legend.className = 'heat-map-legend';
    legend.innerHTML = `
      <div class="legend-gradient"></div>
      <div class="legend-labels"><span>Low</span><span>High</span></div>
    `;
    document.getElementById('map-container').appendChild(legend);
  }
}

// ─── Agent Paths & Hotspots ─────────────────────────────────────────────────────

function processAgentData() {
  addAgentPathsToMap();
  findHotspots();
}

function addAgentPathsToMap() {
  const features = [], waypoints = [];
  const N = Math.min(50, agentData.length);
  const colors = Array.from({ length: N }, () => `hsla(${Math.random()*360},70%,60%,1)`);

  agentData.slice(0, N).forEach((a, i) => {
    if (!a.path || a.path.length < 2) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: a.path },
      properties: { ...a, color: colors[i] }
    });
    waypoints.push(
      { type:'Feature', geometry:{ type:'Point', coordinates: a.path[0] }, properties: { ...a, point_type:'start', color: colors[i] } },
      { type:'Feature', geometry:{ type:'Point', coordinates: a.path.at(-1) }, properties: { ...a, point_type:'end',   color: colors[i] } }
    );
  });

  if (!map.getSource('agent-paths-source')) {
    map.addSource('agent-paths-source', { type:'geojson', data:{ type:'FeatureCollection', features } });
    map.addLayer({
      id: AGENT_PATHS_LAYER_ID, type:'line', source:'agent-paths-source',
      layout:{ 'line-join':'round','line-cap':'round' },
      paint:{ 'line-color':['get','color'], 'line-width':8, 'line-opacity':1 }
    });
  } else {
    map.getSource('agent-paths-source').setData({ type:'FeatureCollection', features });
  }

  if (!map.getSource('agent-waypoints-source')) {
    map.addSource('agent-waypoints-source', { type:'geojson', data:{ type:'FeatureCollection', features: waypoints } });
    map.addLayer({
      id:'agent-waypoints-layer', type:'circle', source:'agent-waypoints-source',
      paint:{ 'circle-radius':5, 'circle-color':['get','color'], 'circle-stroke-width':1, 'circle-stroke-color':'#fff' }
    });
  } else {
    map.getSource('agent-waypoints-source').setData({ type:'FeatureCollection', features: waypoints });
  }
}

function findHotspots() {
  const grid = {};
  agentData.forEach(a => {
    (a.path || []).forEach((pt, i) => {
      if (i === 0) return;
      const [lng,lat] = pt;
      const key = `${Math.floor(lng/0.001)}:${Math.floor(lat/0.001)}`;
      grid[key] = grid[key] || { count:0, coords:pt, td:Array(24).fill(0) };
      grid[key].count++;
      const hour = Math.floor((a.timestamps?.[i]||0)/3600) % 24;
      grid[key].td[hour]++;
    });
  });

  hotspotData = Object.values(grid)
    .filter(h => h.count >= 3)
    .sort((a,b) => b.count - a.count);

  const features = hotspotData.map((h, i) => ({
    type: 'Feature',
    geometry: { type:'Point', coordinates: h.coords },
    properties: { id:`hs_${i}`, weight:h.count, timeDistribution:h.td }
  }));

  if (!map.getSource('hotspots-source')) {
    map.addSource('hotspots-source', { type:'geojson', data:{ type:'FeatureCollection', features }, cluster:true, clusterMaxZoom:14, clusterRadius:50 });
    map.addLayer({
      id:'hotspot-clusters', type:'circle', source:'hotspots-source', filter:['has','point_count'],
      paint:{ 'circle-color':['step',['get','point_count'],'#FFA500',10,'#FF8C00',25,'#FF4500'], 'circle-radius':['step',['get','point_count'],20,10,25,25,30], 'circle-opacity':0.8, 'circle-stroke-width':2, 'circle-stroke-color':'#fff' }
    });
    map.addLayer({
      id: HOTSPOTS_LAYER_ID, type:'circle', source:'hotspots-source', filter:['!',['has','point_count']],
      paint:{ 'circle-radius':['interpolate',['linear'],['get','weight'],3,5,10,10,50,15], 'circle-color':'rgba(255,165,0,0.8)','circle-stroke-width':2,'circle-stroke-color':'#fff' }
    });
  } else {
    map.getSource('hotspots-source').setData({ type:'FeatureCollection', features });
  }
}

// ─── Street Corners & Top-5 ────────────────────────────────────────────────────

function generateStreetCorners() {
  const corners = [];

  if (hotspotData?.length) {
    hotspotData.slice(0,20).forEach((h, i) => {
      const base = h.count * 5 + countNearbyBuildings(h.coords, 0.002);
      corners.push({
        type: 'Feature',
        geometry: { type:'Point', coordinates: h.coords },
        properties: { score: base, buildingCount: countNearbyBuildings(h.coords,0.002), id:`hs_corner_${i}`, timeDistribution:h.td, baseScore:base }
      });
    });
  }

  if (corners.length < 5 && buildingData?.features) {
    const gridSize = 0.002, grid = {};
    buildingData.features.forEach(f => {
      const [lng, lat] = f.geometry.coordinates;
      const gx = Math.floor(lng / gridSize), gy = Math.floor(lat / gridSize), key = `${gx}:${gy}`;
      grid[key] = grid[key] || { count:0, buildings:[], center:[(gx+0.5)*gridSize,(gy+0.5)*gridSize] };
      grid[key].count++;
      grid[key].buildings.push(f.properties);
    });
    Object.values(grid).forEach(cell => {
      if (cell.count >= 3) {
        const adj = cell.buildings.reduce((sum,b) => sum + (b.max_people||0)/100, cell.count);
        corners.push({
          type:'Feature',
          geometry:{ type:'Point', coordinates:cell.center },
          properties:{ score: adj, buildingCount: cell.count, id:`grid_corner`, timeDistribution:Array(24).fill(1), baseScore:adj }
        });
      }
    });
  }

  if (corners.length < 5) {
    const coords = buildingData.features.map(f => f.geometry.coordinates);
    const mean = coords.reduce((acc,c) => [acc[0]+c[0], acc[1]+c[1]], [0,0]).map(v=>v/coords.length);
    const offsets = [[0,0],[0.002,0.002],[-0.002,0.002],[0.002,-0.002],[-0.002,-0.002]];
    offsets.forEach((off,i) => {
      corners.push({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[mean[0]+off[0], mean[1]+off[1]] },
        properties:{ score:100-10*i, buildingCount:10-i, id:`dummy_${i}`, timeDistribution:Array(24).fill(1), baseScore:100-10*i }
      });
    });
  }

  corners.sort((a,b) => b.properties.score - a.properties.score);
  streetCornerData = { type:'FeatureCollection', features:corners };
}

function applyTimeBasedScoring(data, ts) {
  const hour = Math.floor(ts/3600)%24;
  const weights = {
    morning:  hour>=7  && hour<=9  ? 1.5 : 1,
    lunch:    hour>=11 && hour<=13 ? 2   : 1,
    afternoon:hour>=14 && hour<=17 ? 1.2 : 1,
    evening:  hour>=17 && hour<=19 ? 1.8 : 1,
    night:    hour>=20 || hour<=6   ? 0.5 : 1
  };
  const phase = hour<=6  || hour>=20 ? 'night' :
                hour<=9                ? 'morning' :
                hour<=13               ? 'lunch' :
                hour<=17               ? 'afternoon' :
                                         'evening';
  return {
    type:'FeatureCollection',
    features: data.features.map(f => {
      const base = f.properties.baseScore || 0;
      const td   = f.properties.timeDistribution || [];
      const factor = td[hour] / Math.max(...td, 1);
      const score = base * weights[phase] * (1 + factor);
      return { ...f, properties:{ ...f.properties, adjustedScore: score } };
    })
  };
}

function getTop5Locations(data) {
  return {
    type:'FeatureCollection',
    features: data.features
      .filter(f => f.properties.adjustedScore > 0)
      .sort((a,b) => b.properties.adjustedScore - a.properties.adjustedScore)
      .slice(0,5)
      .map((f,i) => (f.properties.rank = i+1, f))
  };
}

function addTop5ToMap(geo) {
  if (!map) return;
  if (map.getLayer(TOP5_LAYER_ID))        map.removeLayer(TOP5_LAYER_ID);
  if (map.getLayer(TOP5_LABELS_LAYER_ID)) map.removeLayer(TOP5_LABELS_LAYER_ID);
  if (map.getSource('top5-source'))       map.removeSource('top5-source');

  if (!geo.features.length) return;

  map.addSource('top5-source', { type:'geojson', data: geo });
  map.addLayer({
    id: TOP5_LAYER_ID, type:'circle', source:'top5-source',
    paint:{ 'circle-radius':20,'circle-color':'#28a745','circle-stroke-width':2,'circle-stroke-color':'#fff' }
  });
  map.addLayer({
    id: TOP5_LABELS_LAYER_ID, type:'symbol', source:'top5-source',
    layout:{ 'text-field':['to-string',['get','rank']],'text-size':14 },
    paint:{ 'text-color':'#fff' }
  });

  const bounds = new mapboxgl.LngLatBounds();
  geo.features.forEach(f => bounds.extend(f.geometry.coordinates));
  map.fitBounds(bounds, { padding:100, maxZoom:15 });
}

function updateLocationsList(geo) {
  const c = document.getElementById('locations-list');
  if (!c) return;
  c.innerHTML = '';
  if (!geo.features.length) {
    c.innerHTML = '<p>No locations for this time</p>';
    return;
  }
  geo.features.forEach((f,i) => {
    const div = document.createElement('div');
    div.className = `location-item ${i===0?'top':''}`;
    div.innerHTML = `
      <div class="location-header">
        <h4>Street Corner ${i+1}</h4>
        <div class="rank-badge">${i+1}</div>
      </div>
      <div><strong>Score:</strong> ${f.properties.adjustedScore.toFixed(1)}</div>
      <div><strong>Buildings:</strong> ${f.properties.buildingCount}</div>
      <div class="coords"><strong>Coords:</strong> ${f.geometry.coordinates[1].toFixed(4)}, ${f.geometry.coordinates[0].toFixed(4)}</div>
      <button onclick="map.flyTo({ center: [${f.geometry.coordinates}], zoom:16 })">Fly to location</button>
    `;
    c.appendChild(div);
  });
}

function updateMapForTime(ts) {
  if (!streetCornerData) return;
  const scored = applyTimeBasedScoring(streetCornerData, ts);
  const top5   = getTop5Locations(scored);
  addTop5ToMap(top5);
  updateLocationsList(top5);

  const hour = Math.floor(ts/3600)%24;
  const opa  = (hour>=6 && hour<=22) ? 0.7 : 0.3;
  if (map.getLayer(AGENT_PATHS_LAYER_ID)) map.setPaintProperty(AGENT_PATHS_LAYER_ID, 'line-opacity', opa);
  if (map.getLayer(HOTSPOTS_LAYER_ID))     map.setPaintProperty(HOTSPOTS_LAYER_ID,     'circle-opacity', opa+0.1);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getHeatMapColor(v) {
  if (v <= 0) return [0,0,255];
  if (v >= 1) return [255,0,0];
  if (v < 0.25)  { const t=v*4; return [0, Math.floor(255*t), 255]; }
  if (v < 0.5)   { const t=(v-0.25)*4; return [0,255, Math.floor(255*(1-t))]; }
  if (v < 0.75)  { const t=(v-0.5)*4; return [Math.floor(255*t),255,0]; }
  { const t=(v-0.75)*4; return [255, Math.floor(255*(1-t)),0]; }
}

function countNearbyBuildings([lng,lat], r) {
  const R = r * 111000;
  return (buildingData?.features || []).reduce((cnt, f) => {
    const [x,y] = f.geometry.coordinates;
    const dx = (x - lng) * Math.cos(lat * Math.PI/180) * 111000;
    const dy = (y - lat) * 111000;
    return cnt + (Math.hypot(dx,dy) <= R ? 1 : 0);
  }, 0);
}

function startLoadingProgress() {
  clearInterval(loadingTimer);
  loadingProgress = 0;
  updateLoadingProgress(0);
  loadingTimer = setInterval(() => {
    loadingProgress = Math.min(95, loadingProgress + (loadingProgress<30?2: loadingProgress<70?1:0.5));
    updateLoadingProgress(Math.round(loadingProgress));
  }, 200);
}

function updateLoadingProgress(n) {
  const el = document.getElementById('loading-progress');
  if (el) el.textContent = `Loading: ${n}%`;
}

function hideLoading() {
  clearInterval(loadingTimer);
  document.getElementById('loading').style.display = 'none';
}

function showError(msg) {
  const e = document.getElementById('error-message');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}

function closeCurrentPopup() {
  if (currentPopup) { currentPopup.remove(); currentPopup = null; }
}
