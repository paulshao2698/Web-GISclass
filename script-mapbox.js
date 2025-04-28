// script-mapbox.js

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

const SF_CENTER       = [-122.4194, 37.7749];
const DEFAULT_ZOOM    = 13;
const MAPBOX_TOKEN    = "pk.eyJ1IjoicGF1bDI2OTgiLCJhIjoiY205bGdzdTdvMDRxbDJqcTd3aGVkcnZ1dSJ9.8eDSkNsHW9K25GU2UN1zrw";

// Layer IDs
const BUILDINGS_LAYER_ID         = 'buildings-layer';
const BUILDINGS_CLUSTER_LAYER_ID = 'buildings-cluster-layer';
const HEATMAP_LAYER_ID           = 'heatmap-layer';
const AGENT_PATHS_LAYER_ID       = 'agent-paths-layer';
const TOP5_LAYER_ID              = 'top5-layer';
const TOP5_LABELS_LAYER_ID       = 'top5-labels-layer';
const HOTSPOTS_LAYER_ID          = 'hotspots-layer';


// ─── Initialization ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initApp);

function initApp() {
  try {
    document.getElementById('retry-button').onclick = useFallbackData;
    initializeMap();
    setupControls();
    startLoadingProgress();

    // fallback if data load stalls
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

// retry logic for map errors
document.addEventListener('click', (e) => {
  if (e.target.id === 'retry-button') {
    document.getElementById('map-error').style.display = 'none';
    if (map) map.remove();
    initializeMap();
  }
});


// ─── UI Controls ────────────────────────────────────────────────────────────────

function setupControls() {
  const slider = document.getElementById('time-slider');
  const display = document.getElementById('time-value');
  
  slider.addEventListener('input', () => {
    const secs = +slider.value;
    display.textContent = formatTime(secs);
    if (document.getElementById('auto-update').checked) {
      updateMapForTime(secs);
    }
  });

  document.getElementById('show-top5-btn')
    .onclick = () => updateMapForTime(+slider.value);

  ;['show-buildings','show-agent-paths','show-heatmap'].forEach(id => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.onchange = function() {
      if (id === 'show-buildings') {
        toggleLayerVisibility(BUILDINGS_LAYER_ID, this.checked);
        toggleLayerVisibility(BUILDINGS_CLUSTER_LAYER_ID, this.checked);
      }
      if (id === 'show-agent-paths' && document.getElementById('deckgl-container')) {
        document.getElementById('deckgl-container').style.display = this.checked ? 'block':'none';
        isPlaying = this.checked && document.getElementById('auto-update').checked;
        if (isPlaying && !animation) animate();
      }
      if (id === 'show-heatmap') {
        toggleLayerVisibility(HEATMAP_LAYER_ID, this.checked);
        toggleLayerVisibility(HOTSPOTS_LAYER_ID, this.checked);
      }
    };
  });
}

function toggleLayerVisibility(layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

function formatTime(seconds) {
  const h = Math.floor(seconds/3600);
  const m = Math.floor((seconds%3600)/60);
  return `${h}`.padStart(2,'0') + ':' + `${m}`.padStart(2,'0');
}


// ─── Data Loading ──────────────────────────────────────────────────────────────

function loadData() {
  updateLoadingProgress(10);

  // Try to fetch simplified buildings, fallback to detailed
  const bldFetch = fetch('building_occupancy_max_people.geojson')
    .then(r => { updateLoadingProgress(20); if (!r.ok) throw 0; return r.json(); })
    .catch(_ => fetch('building_occupancy_sf_5k.json')
      .then(r => { updateLoadingProgress(25); if (!r.ok) throw 0; return r.json(); })
    );

  // Fetch the real agent trips
  const tripFetch = fetch('trips_sf_5k.json')
    .then(r => { updateLoadingProgress(50); if (!r.ok) throw 0; return r.json(); });

  // Wait for BOTH to succeed
  Promise.all([ bldFetch, tripFetch ])
    .then(([ bData, aData ]) => {
      updateLoadingProgress(70);
      buildingData = bData;
      agentData    = aData;

      // 1) add buildings
      addBuildingsToMap();

      // 2) process & generate everything
      processAgentData();
      generateStreetCorners();

      // 3) once the map style is ready, start the DeckGL animation
      if (map.isStyleLoaded()) {
        initializeTripsAnimation();
      } else {
        map.once('style.load', initializeTripsAnimation);
      }

      // 4) render for the current slider time
      const t = parseInt(document.getElementById('time-slider').value, 10);
      updateMapForTime(t);

      updateLoadingProgress(100);
      hideLoading();
    })
    .catch(err => {
      console.warn('Real data load failed, falling back:', err);
      useFallbackData();
    });
}

// your existing fallback (no change)
function useFallbackData() {
  console.log('Using sample data as fallback');
  // … all your old sampleBuildingData/sampleAgentData logic …
  generateStreetCorners();
  initializeTripsAnimation();
  hideLoading();
  showError('Using sample data (real data could not be loaded)');
}

// Re-usable trip prep + animation
function initializeTripsAnimation() {
  if (!agentData || !map) {
    console.warn('Cannot initialize trips animation: missing agent data or map');
    return;
  }
  
  console.log('Initializing trips animation with', agentData.length, 'agents');
  
  // Create MapboxOverlay if it doesn't exist
  if (!deckOverlay) {
    deckOverlay = new deck.MapboxOverlay({
      layers: []
    });
    map.addControl(deckOverlay);
  }
  
  // Process agent data for the trips layer
  prepareTripsData();
  
  // Set up the animation controls
  setupAnimationControls();
  
  // Start the animation loop
  animate();
}

// Process agent data for trips animation
function prepareTripsData() {
  if (!agentData || !Array.isArray(agentData) || agentData.length === 0) {
    console.warn('No agent data available for trip animation');
    return;
  }
  
  // Filter valid trips
  const validAgents = agentData.filter(agent => 
    agent.path && Array.isArray(agent.path) && agent.path.length > 1 && 
    agent.timestamps && Array.isArray(agent.timestamps) && 
    agent.timestamps.length > 0
  );
  
  console.log(`Found ${validAgents.length} valid agents for trip animation`);
  
  if (validAgents.length === 0) {
    console.warn('No valid agent paths found for animation');
    return;
  }
  
  // Get time range for animation
  const allTimestamps = validAgents.flatMap(agent => agent.timestamps);
  const minTimestamp = Math.min(...allTimestamps);
  const maxTimestamp = Math.max(...allTimestamps);
  loopLength = maxTimestamp - minTimestamp;
  
  console.log(`Trip animation time range: ${formatTime(minTimestamp)} to ${formatTime(maxTimestamp)}`);
  
  // Route frequencies for coloring
  const routes = {};
  validAgents.forEach(agent => {
    const routeKey = `${agent.place_from}-${agent.place_to}`;
    if (!routes[routeKey]) {
      routes[routeKey] = {
        count: 0,
        agents: []
      };
    }
    routes[routeKey].count++;
    routes[routeKey].agents.push(agent.agent_id);
  });
  
  // Get max route frequency for normalization
  const sortedRoutes = Object.entries(routes)
    .sort((a, b) => b[1].count - a[1].count);
  const maxRouteCount = sortedRoutes.length > 0 ? sortedRoutes[0][1].count : 1;
  
  // Format data for deck.gl
  tripsData = validAgents.map(agent => {
    const routeKey = `${agent.place_from}-${agent.place_to}`;
    const routePopularity = routes[routeKey] ? routes[routeKey].count / maxRouteCount : 0;
    
    return {
      path: agent.path.map(coords => [...coords, 0]), // Add elevation (0)
      timestamps: agent.timestamps.map(t => t - minTimestamp), // Normalize timestamps
      agent_id: agent.agent_id,
      place_from: agent.place_from,
      place_to: agent.place_to,
      color: getHeatMapColor(routePopularity)
    };
  });
  
  // Update slider
  const timeSlider = document.getElementById('time-slider');
  if (timeSlider) {
    timeSlider.max = loopLength;
    timeSlider.value = 0;
  }
  
  // Initial render
  currentTime = 0;
  updateTripsVisualization(currentTime);
}
function createTripsLayer(time) {
  return new deck.TripsLayer({
    id: 'trips-layer',
    data: tripsData,
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: d => d.color,
    getWidth: d => 4, // Fixed width for better visibility
    widthMinPixels: 2,
    widthMaxPixels: 8,
    currentTime: time,
    opacity: 0.8,
    rounded: true,
    trailLength: 200,
    capRounded: true,
    jointRounded: true,
    shadowEnabled: false,
    pickable: true,
    onHover: info => {
      if (info.object && map) {
        // Close any existing popup
        if (currentPopup) {
          currentPopup.remove();
          currentPopup = null;
        }
        
        // Create new popup
        currentPopup = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: true
        })
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
}
function updateTripsVisualization(time) {
  // Update slider and time display
  const timeSlider = document.getElementById('time-slider');
  const timeValue = document.getElementById('time-value');
  
  if (timeSlider) {
    timeSlider.value = time;
  }
  
  if (timeValue) {
    // Format time display
    const totalSeconds = Math.floor(time);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    timeValue.textContent = `${hours}:${minutes.toString().padStart(2, '0')}`;
  }
  
  // Update deck.gl layer
  if (deckOverlay) {
    deckOverlay.setProps({
      layers: [createTripsLayer(time)]
    });
  }
}

function animate() {
  if (isPlaying) {
    currentTime = (currentTime + animationSpeed) % loopLength;
    updateTripsVisualization(currentTime);
  }
  requestAnimationFrame(animate);
}


// ─── Building + Heatmap ────────────────────────────────────────────────────────

function addBuildingsToMap() {
  if (!map || !buildingData) return;
  const processed = {
    type:'FeatureCollection',
    features: buildingData.features.map(f=>{
      const nf = JSON.parse(JSON.stringify(f));
      if (!nf.properties.max_people && Array.isArray(nf.properties.people)) {
        nf.properties.max_people = Math.max(...nf.properties.people.filter(x=>!isNaN(x)));
      }
      return nf;
    })
  };

  if (!map.getSource('buildings-source')) {
    map.addSource('buildings-source', {
      type:'geojson', data:processed, cluster:true, clusterMaxZoom:14, clusterRadius:50
    });

    map.addLayer({
      id: BUILDINGS_LAYER_ID,
      type: 'circle',
      source: 'buildings-source',
      filter: ['!', ['has','point_count']],
      paint: {
        'circle-radius':['interpolate',['linear'],['get','max_people'],0,3,100,5,500,8,1000,10],
        'circle-color':['interpolate',['linear'],['get','max_people'],0,'#BBDEFB',100,'#64B5F6',500,'#2196F3',1000,'#1976D2'],
        'circle-opacity':0.7
      }
    });

    map.addLayer({
      id: BUILDINGS_CLUSTER_LAYER_ID,
      type: 'circle',
      source: 'buildings-source',
      filter: ['has','point_count'],
      paint: {
        'circle-color':['step',['get','point_count'],'#51bbd6',100,'#f1f075',750,'#f28cb1'],
        'circle-radius':['step',['get','point_count'],20,100,30,750,40]
      }
    });

    map.addLayer({
      id: 'cluster-count',
      type:'symbol',
      source:'buildings-source',
      filter:['has','point_count'],
      layout:{'text-field':'{point_count_abbreviated}','text-size':12}
    });
  } else {
    map.getSource('buildings-source').setData(processed);
  }

  addHeatmapLayer();
}

function addHeatmapLayer() {
  if (!map.getSource('buildings-source') || map.getLayer(HEATMAP_LAYER_ID)) return;
  map.addLayer({
    id: HEATMAP_LAYER_ID, type:'heatmap', source:'buildings-source', maxzoom:15,
    paint:{
      'heatmap-weight':['interpolate',['linear'],['get','max_people'],0,0,100,0.2,500,0.6,1000,1],
      'heatmap-intensity':['interpolate',['linear'],['zoom'],10,1,15,3],
      'heatmap-color':['interpolate',['linear'],['heatmap-density'],
        0,'rgba(0,0,255,0)',
        0.2,'rgba(0,0,255,0.5)',
        0.4,'rgba(0,255,255,0.5)',
        0.6,'rgba(0,255,0,0.5)',
        0.8,'rgba(255,255,0,0.5)',
        1,'rgba(255,0,0,0.5)'
      ],
      'heatmap-radius':['interpolate',['linear'],['zoom'],10,20,15,40],
      'heatmap-opacity':0.7
    }
  });
  addHeatmapLegend();
}

function addHeatmapLegend() {
  if (document.querySelector('.heat-map-legend')) return;
  const legend = document.createElement('div');
  legend.className = 'heat-map-legend';
  legend.innerHTML = `
    <div class="legend-gradient"></div>
    <div class="legend-labels">
      <span>Low</span><span>High</span>
    </div>`;
  document.getElementById('map-container').appendChild(legend);
}


// ─── Agent Paths + Hotspots ────────────────────────────────────────────────────

function processAgentData() {
  if (!agentData) return;
  addAgentPathsToMap();
  findHotspots();
}

function addAgentPathsToMap() {
  if (!map || !agentData) return;
  const features = [], waypoints = [];
  const N = Math.min(50, agentData.length);
  const colors = Array.from({length:N}, ()=>'hsla('+Math.random()*360+',70%,60%,0.6)');

  for (let i=0; i<N; i++) {
    const a = agentData[i];
    if (!a.path||a.path.length<2) continue;
    features.push({
      type:'Feature',
      geometry:{type:'LineString',coordinates:a.path},
      properties:{
        agent_id:a.agent_id, place_from:a.place_from,
        place_to:a.place_to, timestamps:[...a.timestamps],
        color:colors[i]
      }
    });
    waypoints.push({
      type:'Feature', geometry:{type:'Point',coordinates:a.path[0]},
      properties:{agent_id:a.agent_id, point_type:'start', place:a.place_from, color:colors[i]}
    },{
      type:'Feature', geometry:{type:'Point',coordinates:a.path.at(-1)},
      properties:{agent_id:a.agent_id, point_type:'end',   place:a.place_to,   color:colors[i]}
    });
  }

  // add/update agent-paths
  if (!map.getSource('agent-paths-source')) {
    map.addSource('agent-paths-source',{type:'geojson',data:{type:'FeatureCollection',features}});
    map.addLayer({
      id:AGENT_PATHS_LAYER_ID, type:'line', source:'agent-paths-source',
      layout:{'line-join':'round','line-cap':'round'},
      paint:{'line-color':['get','color'],'line-width':2,'line-opacity':0.7}
    });

    map.on('mouseenter', AGENT_PATHS_LAYER_ID, e => {
      map.getCanvas().style.cursor = 'pointer';
      const p = e.features[0].properties;
      map.setPaintProperty(AGENT_PATHS_LAYER_ID,'line-width',[
        'case',['==',['get','agent_id'],p.agent_id],4,2
      ]);
      new mapboxgl.Popup({closeButton:false,closeOnClick:true})
        .setLngLat(e.lngLat)
        .setHTML(`<strong>Agent ${p.agent_id}</strong><br>From ${p.place_from}<br>To ${p.place_to}`)
        .addTo(map);
    });
    map.on('mouseleave', AGENT_PATHS_LAYER_ID, ()=>{
      map.getCanvas().style.cursor = '';
      map.setPaintProperty(AGENT_PATHS_LAYER_ID,'line-width',2);
    });
  } else {
    map.getSource('agent-paths-source').setData({type:'FeatureCollection',features});
  }

  // add/update waypoints
  if (!map.getSource('agent-waypoints-source')) {
    map.addSource('agent-waypoints-source',{type:'geojson',data:{type:'FeatureCollection',features:waypoints}});
    map.addLayer({
      id:'agent-waypoints-layer', type:'circle', source:'agent-waypoints-source',
      paint:{'circle-radius':5,'circle-color':['get','color'],'circle-stroke-width':1,'circle-stroke-color':'#fff'}
    });
    map.on('mouseenter','agent-waypoints-layer', e=>{
      map.getCanvas().style.cursor='pointer';
      const p = e.features[0].properties;
      new mapboxgl.Popup({closeButton:false,closeOnClick:true,offset:10})
        .setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`<strong>Agent ${p.agent_id}</strong><br>${p.point_type==='start'?'From':'To'} ${p.place}`)
        .addTo(map);
    });
    map.on('mouseleave','agent-waypoints-layer',()=>map.getCanvas().style.cursor='');
  } else {
    map.getSource('agent-waypoints-source').setData({type:'FeatureCollection',features:waypoints});
  }
}

function findHotspots() {
  if (!agentData) return;
  const grid={}, points=[];

  agentData.forEach(a=>{
    if (!a.path) return;
    for(let i=1;i<a.path.length;i++){
      const [lng,lat] = a.path[i];
      const key = `${Math.floor(lng/0.001)}:${Math.floor(lat/0.001)}`;
      grid[key] = grid[key]||{count:0,coords:[lng,lat],td:Array(24).fill(0)};
      grid[key].count++;
      const h = Math.floor((a.timestamps?.[i]||0)/3600)%24;
      grid[key].td[h]++;
    }
  });

  for (let k in grid) {
    if (grid[k].count>=3) {
      points.push({coordinates:grid[k].coords, weight:grid[k].count, timeDistribution:grid[k].td});
    }
  }
  points.sort((a,b)=>b.weight-a.weight);
  hotspotData = points;
  addHotspotsToMap();
}

function addHotspotsToMap() {
  if (!hotspotData) return;
  const features = hotspotData.map((h,i)=>({
    type:'Feature',
    geometry:{type:'Point',coordinates:h.coordinates},
    properties:{id:`hs_${i}`,weight:h.weight,timeDistribution:h.timeDistribution}
  }));

  if (!map.getSource('hotspots-source')) {
    map.addSource('hotspots-source',{type:'geojson',data:{type:'FeatureCollection',features}, cluster:true, clusterMaxZoom:14, clusterRadius:50});

    map.addLayer({
      id:'hotspot-clusters', type:'circle', source:'hotspots-source', filter:['has','point_count'],
      paint:{
        'circle-color':['step',['get','point_count'],'#FFA500',10,'#FF8C00',25,'#FF4500'],
        'circle-radius':['step',['get','point_count'],20,10,25,25,30],
        'circle-opacity':0.8,'circle-stroke-width':2,'circle-stroke-color':'#fff'
      }
    });
    map.addLayer({
      id:'hotspot-labels', type:'symbol', source:'hotspots-source', filter:['has','point_count'],
      layout:{'text-field':'{point_count} agents','text-size':12}, paint:{'text-color':'#fff'}
    });
    map.on('click','hotspot-clusters',e=>{
      const cid = e.features[0].properties.cluster_id;
      map.getSource('hotspots-source').getClusterExpansionZoom(cid,(err,zoom)=>{
        if(!err) map.easeTo({center:e.features[0].geometry.coordinates,zoom});
      });
    });
    map.on('mouseenter','hotspot-clusters',()=>map.getCanvas().style.cursor='pointer');
    map.on('mouseleave','hotspot-clusters',()=>map.getCanvas().style.cursor='');

    map.addLayer({
      id: HOTSPOTS_LAYER_ID, type:'circle', source:'hotspots-source', filter:['!',['has','point_count']],
      paint:{
        'circle-radius':['interpolate',['linear'],['get','weight'],3,5,10,10,50,15],
        'circle-color':'rgba(255,165,0,0.8)','circle-stroke-width':2,'circle-stroke-color':'#fff'
      }
    });
    map.addLayer({
      id:'hotspot-point-labels', type:'symbol', source:'hotspots-source', filter:['!',['has','point_count']],
      layout:{'text-field':'{weight} agents','text-size':10,'text-offset':[0,1.5]},
      paint:{'text-color':'#333','text-halo-color':'#fff','text-halo-width':1}
    });
    map.on('mouseenter', HOTSPOTS_LAYER_ID, e=>{
      map.getCanvas().style.cursor='pointer';
      const p=e.features[0].properties, c=e.features[0].geometry.coordinates;
      new mapboxgl.Popup({closeButton:false,closeOnClick:true,offset:15})
        .setLngLat(c)
        .setHTML(`<strong>Hotspot</strong><br>Traffic: ${p.weight} agents`)
        .addTo(map);
    });
    map.on('mouseleave', HOTSPOTS_LAYER_ID, ()=>map.getCanvas().style.cursor='');
  } else {
    map.getSource('hotspots-source').setData({type:'FeatureCollection',features});
  }
}


// ─── Deck.GL Trips Animation ──────────────────────────────────────────────────

function initializeTripsAnimation() {
  if (!agentData || !map) {
    console.warn('Cannot initialize trips animation: missing agent data or map');
    return;
  }
  
  // Wait for map style to load
  if (!map.isStyleLoaded()) {
    map.once('style.load', initializeTripsAnimation);
    return;
  }
  
  console.log('Initializing trips animation with', agentData.length, 'agents');
  
  // Remove existing container if present
  const existingContainer = document.getElementById('deckgl-container');
  if (existingContainer) existingContainer.remove();
  
  // Create new container
  const deckContainer = document.createElement('div');
  deckContainer.id = 'deckgl-container';
  document.getElementById('map-container').appendChild(deckContainer);
  
  // Initialize DeckGL
  const center = map.getCenter();
  deckgl = new deck.DeckGL({
    container: 'deckgl-container',
    mapStyle: null, // No base map (we're using Mapbox)
    initialViewState: {
      longitude: center.lng,
      latitude: center.lat,
      zoom: map.getZoom(),
      pitch: 30, // Add slight pitch for better 3D effect
      bearing: 0
    },
    controller: false
  });
  
  // Sync map and deck.gl viewports
  map.on('move', () => {
    if (!deckgl) return;
    
    deckgl.setProps({
      viewState: {
        longitude: map.getCenter().lng,
        latitude: map.getCenter().lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing()
      }
    });
  });
  
  // Initial visibility based on checkbox state
  const pathsCheckbox = document.getElementById('show-agent-paths');
  if (pathsCheckbox) {
    deckContainer.style.display = pathsCheckbox.checked ? 'block' : 'none';
    isPlaying = pathsCheckbox.checked;
  }
  
  // Prepare data and start animation
  prepareTripsData();
  
  // Make sure the checkbox properly controls visibility
  fixCheckboxBehavior();
  
  // Start animation if appropriate
  animate();
}

// Fix checkbox control behavior
function fixCheckboxBehavior() {
  const pathsCheckbox = document.getElementById('show-agent-paths');
  if (!pathsCheckbox) return;
  
  // Override the checkbox listener
  pathsCheckbox.addEventListener('change', function() {
    const container = document.getElementById('deckgl-container');
    if (container) {
      container.style.display = this.checked ? 'block' : 'none';
    }
    
    // Control animation
    isPlaying = this.checked && 
                document.getElementById('auto-update') && 
                document.getElementById('auto-update').checked;
    
    if (isPlaying && !animation) {
      animate();
    }
  });
}

function prepareTripsData() {
  if (!agentData || !Array.isArray(agentData) || agentData.length === 0) {
    console.warn('No agent data available for trip animation');
    return;
  }
  
  // Filter for valid agents with proper path and timestamps
  const validAgents = agentData.filter(agent => 
    agent.path && Array.isArray(agent.path) && agent.path.length > 1 && 
    agent.timestamps && Array.isArray(agent.timestamps) && 
    agent.path.length === agent.timestamps.length
  );
  
  console.log(`Found ${validAgents.length} valid agents for trip animation`);
  
  if (validAgents.length === 0) {
    console.warn('No valid agent paths found for animation');
    return;
  }
  
  // Find min/max timestamps
  const allTimestamps = validAgents.flatMap(agent => agent.timestamps);
  minTimestamp = Math.min(...allTimestamps);
  const maxTimestamp = Math.max(...allTimestamps);
  loopLength = maxTimestamp - minTimestamp;
  
  console.log(`Trip animation time range: ${formatTime(minTimestamp)} to ${formatTime(maxTimestamp)}`);
  
  // Calculate route frequencies for coloring
  const routes = {};
  validAgents.forEach(agent => {
    const routeKey = `${agent.place_from}-${agent.place_to}`;
    if (!routes[routeKey]) {
      routes[routeKey] = {
        count: 0,
        agents: []
      };
    }
    routes[routeKey].count++;
    routes[routeKey].agents.push(agent.agent_id);
  });
  
  // Get max route frequency for normalization
  const maxRouteCount = Math.max(...Object.values(routes).map(r => r.count));
  
  // Format the trips data for deck.gl's TripsLayer
  tripsData = validAgents.map(agent => {
    // Get route popularity
    const routeKey = `${agent.place_from}-${agent.place_to}`;
    const routePopularity = routes[routeKey] ? routes[routeKey].count / maxRouteCount : 0;
    
    // Set color based on route popularity (hot to cold scale)
    const color = getHeatMapColor(routePopularity);
    
    return {
      path: agent.path.map(coords => [...coords, 0]), // Add elevation (0)
      timestamps: agent.timestamps.map(t => t - minTimestamp), // Normalize timestamps
      agent_id: agent.agent_id,
      place_from: agent.place_from,
      place_to: agent.place_to,
      routePopularity: routePopularity,
      color: color
    };
  });
  
  // Update the time slider range
  const timeSlider = document.getElementById('time-slider');
  if (timeSlider) {
    timeSlider.min = 0;
    timeSlider.max = loopLength;
    timeSlider.value = 0;
  }
  
  // Initial render
  currentTime = 0;
  updateTripsAnimation(currentTime);
}

// Improved animation loop
function animate() {
  if (!isPlaying || !deckgl || !tripsData) {
    if (animation) {
      cancelAnimationFrame(animation);
      animation = null;
    }
    return;
  }
  
  // Increment time and loop
  currentTime = (currentTime + tripAnimationSpeed) % loopLength;
  
  // Update visualization
  updateTripsAnimation(currentTime);
  
  // Request next frame
  animation = requestAnimationFrame(animate);
}

// Enhanced trip layer rendering
function updateTripsAnimation(time) {
  if (!deckgl || !tripsData) return;
  
  // Update UI elements
  const timeSlider = document.getElementById('time-slider');
  if (timeSlider) {
    timeSlider.value = time;
  }
  
  const timeValue = document.getElementById('time-value');
  if (timeValue) {
    timeValue.textContent = formatTime(time + minTimestamp);
  }
  
  // Create improved trips layer
  const tripsLayer = new deck.TripsLayer({
    id: 'trips-layer',
    data: tripsData,
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: d => d.color,
    getWidth: d => 3 + (d.routePopularity * 5), // Wider lines for better visibility
    widthMinPixels: 2,
    widthMaxPixels: 8,
    opacity: 0.85,
    rounded: true,
    fadeTrail: true, // Creates nicer animation effect
    trailLength: 200, // Longer trail to see more of the route
    currentTime: time,
    pickable: true,
    capRounded: true,
    jointRounded: true,
    shadowEnabled: false,
    onHover: info => {
      closeCurrentPopup();
      if (info.object && map) {
        currentPopup = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: true,
          offset: 10
        })
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
  
  // Update deck.gl layers
  deckgl.setProps({ layers: [tripsLayer] });
}

function updateTripsAnimation(time) {
  if (!deckgl || !tripsData || tripsData.length === 0) {
    console.warn('Cannot update animation: missing deck.gl instance or trip data');
    return;
  }
  
  // Update time slider
  const timeSlider = document.getElementById('time-slider');
  if (timeSlider) {
    timeSlider.value = time;
  }
  
  // Update time display
  const timeValue = document.getElementById('time-value');
  if (timeValue) {
    timeValue.textContent = formatTime(time + minTimestamp);
  }
  
  // Create the trips layer with enhanced visibility
  const tripsLayer = new deck.TripsLayer({
    id: 'trips-layer',
    data: tripsData,
    getPath: d => d.path,
    getTimestamps: d => d.timestamps,
    getColor: d => d.color,
    getWidth: d => 3 + (d.routePopularity * 5), // Wider lines for better visibility
    widthMinPixels: 2,
    widthMaxPixels: 10,
    opacity: 0.85, // More opaque
    rounded: true,
    fadeTrail: true, // Fade the trail to improve animation visibility
    trailLength: 200, // Longer trail for better animation effect
    currentTime: time,
    pickable: true,
    shadowEnabled: false,
    capRounded: true,
    jointRounded: true,
    onHover: info => {
      // Handle hover events
      if (info.object && map) {
        closeCurrentPopup();
        currentPopup = new mapboxgl.Popup({ closeButton: false })
          .setLngLat(info.coordinate)
          .setHTML(`
            <div style="padding:5px">
              <strong>Agent ${info.object.agent_id}</strong><br>
              From: ${info.object.place_from}<br>
              To: ${info.object.place_to}
            </div>
          `)
          .addTo(map);
      }
    }
  });
  
  // Update the deck.gl layers
  deckgl.setProps({
    layers: [tripsLayer]
  });
}


// ─── Street Corners & Top-5 ────────────────────────────────────────────────────

function generateStreetCorners() {
  if (!map || !buildingData || !buildingData.features || buildingData.features.length === 0) {
    console.warn('No building data available to generate street corners');
    showError('Error generating street corner data');
    return;
  }

  try {
    const corners = [];

    // 1) Use hotspots if available
    if (hotspotData && hotspotData.length > 0) {
      console.log('Using agent hotspots to generate street corners');
      const topHotspots = hotspotData.slice(0, 20);
      topHotspots.forEach((hotspot, index) => {
        let score = hotspot.weight * 5; // base from traffic
        const nearbyBuildings = countNearbyBuildings(hotspot.coordinates, 0.002);
        score += nearbyBuildings;

        const f = {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: hotspot.coordinates
          },
          properties: {
            score,
            buildingCount: nearbyBuildings,
            id: `hotspot_corner_${index}`,
            timeDistribution: hotspot.timeDistribution || Array(24).fill(1)
          }
        };
        // ✨ NEW: preserve the original score for time‐based reweighting
        f.properties.baseScore = f.properties.score;

        corners.push(f);
      });
    }

    // 2) If fewer than 5, add grid‐based building clusters
    if (corners.length < 5) {
      console.log('Adding additional corners based on building clusters');
      const gridSize = 0.002;
      const grid = {};

      buildingData.features.forEach(feature => {
        if (!feature.geometry || !feature.geometry.coordinates) return;
        const [lng, lat] = feature.geometry.coordinates;
        if (isNaN(lng) || isNaN(lat)) return;

        const gx = Math.floor(lng / gridSize),
              gy = Math.floor(lat / gridSize),
              key = `${gx}:${gy}`;

        if (!grid[key]) {
          grid[key] = { count: 0, buildings: [], center: [(gx+0.5)*gridSize, (gy+0.5)*gridSize] };
        }
        grid[key].count++;
        grid[key].buildings.push({
          id: feature.properties.building_id || '',
          maxPeople: feature.properties.max_people || 0
        });
      });

      const dirs = [[0,0],[0,1],[1,0],[0,-1],[-1,0],[1,1],[1,-1],[-1,-1],[-1,1]];
      Object.entries(grid).forEach(([key, cell]) => {
        const [gx, gy] = key.split(':').map(Number);
        let adjCount = 0, adjBuildings = [];
        dirs.forEach(([dx,dy]) => {
          const c = grid[`${gx+dx}:${gy+dy}`];
          if (c) {
            adjCount += c.count;
            adjBuildings = adjBuildings.concat(c.buildings);
          }
        });
        if (adjCount >= 3) {
          let cornerScore = adjCount;
          adjBuildings.forEach(b => cornerScore += b.maxPeople/100);

          const [cornerLng, cornerLat] = [(gx+0.5)*gridSize, (gy+0.5)*gridSize];
          const f = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [cornerLng, cornerLat] },
            properties: {
              score: cornerScore,
              buildingCount: adjCount,
              id: `corner_${gx}_${gy}`,
              timeDistribution: Array(24).fill(1)
            }
          };
          f.properties.baseScore = f.properties.score;
          corners.push(f);
        }
      });
    }

    // 3) If still fewer than 5, sprinkle dummy corners around the mean
    if (corners.length < 5) {
      console.warn("Not enough corners generated, creating dummy corners");
      let sumLng = 0, sumLat = 0, cnt = 0;
      buildingData.features.forEach(f => {
        const [lng, lat] = f.geometry.coordinates;
        if (!isNaN(lng) && !isNaN(lat)) {
          sumLng += lng;
          sumLat += lat;
          cnt++;
        }
      });
      if (cnt > 0) {
        const centerLng = sumLng / cnt,
              centerLat = sumLat / cnt,
              offsets = [[0,0],[0.002,0.002],[-0.002,0.002],[0.002,-0.002],[-0.002,-0.002]];
        offsets.forEach((off, i) => {
          const score = 100 - i*10;
          const f = {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [centerLng + off[0], centerLat + off[1]]
            },
            properties: {
              score,
              buildingCount: 10 - i,
              id: `dummy_corner_${i}`,
              timeDistribution: Array(24).fill(1)
            }
          };
          f.properties.baseScore = f.properties.score;
          corners.push(f);
        });
      }
    }

    // 4) Sort & store
    corners.sort((a, b) => b.properties.score - a.properties.score);
    streetCornerData = { type: 'FeatureCollection', features: corners };
    console.log(`Generated ${corners.length} street corners`);

  } catch (err) {
    console.error("Error generating street corners:", err);
    showError('Error generating street corner data');
  }
}

function updateMapForTime(ts) {
  if (!streetCornerData) return;
  const adjusted = applyTimeBasedScoring(streetCornerData, ts);
  const top5 = getTop5Locations(adjusted);
  addTop5ToMap(top5);
  updateLocationsList(top5);
  updateAgentPathsForTime(ts);
}

function applyTimeBasedScoring(data, ts) {
  const hour = Math.floor(ts/3600)%24;
  const weights = {
    morning: hour>=7&&hour<=9 ?1.5:1,
    lunch:   hour>=11&&hour<=13?2:1,
    afternoon:hour>=14&&hour<=17?1.2:1,
    evening: hour>=17&&hour<=19?1.8:1,
    night:   hour>=20||hour<=6 ?0.5:1
  };
  return {
    type:'FeatureCollection',
    features: data.features.map(f=>{
      let tm = weights.night;
      if (hour>=7&&hour<=9) tm=weights.morning;
      else if (hour>=11&&hour<=13) tm=weights.lunch;
      else if (hour>=14&&hour<=17) tm=weights.afternoon;
      else if (hour>=17&&hour<=19) tm=weights.evening;

      const base = f.properties.score||0;
      if (Array.isArray(f.properties.timeDistribution)) {
        const td = f.properties.timeDistribution;
        const factor = 1 + (td[hour]/Math.max(...td));
        tm *= factor;
      }
      return {
        ...f,
        properties:{
          ...f.properties,
          adjustedScore: base * tm
        }
      };
    })
  };
}

function getTop5Locations(data) {
  const feats = data.features
    .filter(f=>f.properties.adjustedScore>0)
    .sort((a,b)=>b.properties.adjustedScore - a.properties.adjustedScore)
    .slice(0,5);
  feats.forEach((f,i)=>f.properties.rank=i+1);
  return {type:'FeatureCollection',features:feats};
}

function addTop5ToMap(geo) {
  if (!map) return;
  if (map.getLayer(TOP5_LAYER_ID))   map.removeLayer(TOP5_LAYER_ID);
  if (map.getLayer(TOP5_LABELS_LAYER_ID)) map.removeLayer(TOP5_LABELS_LAYER_ID);
  if (map.getSource('top5-source'))  map.removeSource('top5-source');
  if (!geo.features.length) return;

  map.addSource('top5-source',{type:'geojson',data:geo});
  map.addLayer({
    id:TOP5_LAYER_ID, type:'circle', source:'top5-source',
    paint:{'circle-radius':20,'circle-color':'#28a745','circle-stroke-width':2,'circle-stroke-color':'#fff'}
  });
  map.addLayer({
    id:TOP5_LABELS_LAYER_ID, type:'symbol', source:'top5-source',
    layout:{'text-field':['to-string',['get','rank']],'text-size':14},
    paint:{'text-color':'#fff'}
  });
  map.on('mouseenter', TOP5_LAYER_ID, e=>{
    map.getCanvas().style.cursor='pointer';
    const p = e.features[0].properties;
    new mapboxgl.Popup({closeButton:false,closeOnClick:true})
      .setLngLat(e.lngLat)
      .setHTML(`<strong>Street Corner ${p.rank}</strong><br>
                Score: ${+p.adjustedScore.toFixed(1)}<br>
                Nearby buildings: ${p.buildingCount}`)
      .addTo(map);
  });
  map.on('mouseleave', TOP5_LAYER_ID,()=>map.getCanvas().style.cursor='');

  // fit
  const b = new mapboxgl.LngLatBounds();
  geo.features.forEach(f=>b.extend(f.geometry.coordinates));
  map.fitBounds(b,{padding:100,maxZoom:15});
}

function updateLocationsList(geo) {
  const c = document.getElementById('locations-list');
  if (!c) return;
  c.innerHTML = '';
  if (!geo.features.length) {
    c.innerHTML = '<p>No locations for this time</p>'; return;
  }
  geo.features.forEach((f,i)=>{
    const div = document.createElement('div');
    div.className = `location-item ${i===0?'top':''}`;
    div.innerHTML = `
      <div class="location-header">
        <h4>Street Corner ${i+1}</h4>
        <div class="rank-badge">${i+1}</div>
      </div>
      <div><strong>Score:</strong> ${+f.properties.adjustedScore.toFixed(1)}</div>
      <div><strong>Buildings:</strong> ${f.properties.buildingCount}</div>
      <div style="font-size:12px;color:#666">
        <strong>Coords:</strong> ${f.geometry.coordinates[1].toFixed(4)}, ${f.geometry.coordinates[0].toFixed(4)}
      </div>
      <button style="margin-top:8px;font-size:12px" onclick="
        map.flyTo({center:[${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}],zoom:16})
      ">Fly to location</button>
    `;
    c.appendChild(div);
  });
}

function updateAgentPathsForTime(ts) {
  const hour = Math.floor(ts/3600)%24;
  const opa = (hour>=6&&hour<=22)?0.7:0.3;
  if (map.getLayer(AGENT_PATHS_LAYER_ID)) map.setPaintProperty(AGENT_PATHS_LAYER_ID,'line-opacity',opa);
  if (map.getLayer(HOTSPOTS_LAYER_ID))      map.setPaintProperty(HOTSPOTS_LAYER_ID,'circle-opacity',opa+0.1);
}


// ─── Utils ────────────────────────────────────────────────────────────────────

function getHeatMapColor(v) {
  if (v<=0) return [0,0,255];
  if (v>=1) return [255,0,0];
  if (v<0.25) {
    const t=v*4; return [0,Math.floor(255*t),255];
  } else if (v<0.5) {
    const t=(v-0.25)*4; return [0,255,Math.floor(255*(1-t))];
  } else if (v<0.75) {
    const t=(v-0.5)*4; return [Math.floor(255*t),255,0];
  } else {
    const t=(v-0.75)*4; return [255,Math.floor(255*(1-t)),0];
  }
}

function countNearbyBuildings([lng,lat],r) {
  if (!buildingData?.features) return 0;
  let cnt=0, R=r*111000;
  buildingData.features.forEach(f=>{
    const [x,y]=f.geometry.coordinates;
    const dx=(x-lng)*Math.cos(lat*Math.PI/180)*111000;
    const dy=(y-lat)*111000;
    if (Math.hypot(dx,dy)<=R) cnt++;
  });
  return cnt;
}

function startLoadingProgress() {
  stopLoadingProgress();
  loadingProgress=0; updateLoadingProgress(0);
  loadingTimer = setInterval(()=>{
    loadingProgress = Math.min(95, loadingProgress + (loadingProgress<30?2: loadingProgress<70?1:0.5));
    updateLoadingProgress(Math.floor(loadingProgress));
  },200);
}
function updateLoadingProgress(n) {
  const el = document.getElementById('loading-progress');
  if (el) el.textContent = `Loading: ${n}%`;
}
function stopLoadingProgress() {
  clearInterval(loadingTimer);
  loadingTimer = null;
}
function hideLoading() {
  stopLoadingProgress();
  document.getElementById('loading').style.display = 'none';
}
function showError(msg) {
  const e = document.getElementById('error-message');
  if (e) { e.textContent = msg; e.style.display = 'block'; }
}
function closeCurrentPopup() {
  if (currentPopup) { currentPopup.remove(); currentPopup = null; }
}