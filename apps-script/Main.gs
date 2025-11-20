//==================================================================
// ADD-ON BOILERPLATE
//==================================================================

const SCRIPT_VERSION = "4.67";
const MODEL_ID = "gemini-2.5-flash"; 

const FALLBACK_ICONS = {
    GENERIC: "https://www.gstatic.com/images/branding/product/2x/google_cloud_48dp.png",
    COMPUTE: "https://fonts.gstatic.com/s/i/productlogos/compute_engine/v8/web-48dp/logo_compute_engine_color_2x_web_48dp.png",
    STORAGE: "https://fonts.gstatic.com/s/i/productlogos/cloud_storage/v8/web-48dp/logo_cloud_storage_color_2x_web_48dp.png",
    DATABASE: "https://fonts.gstatic.com/s/i/productlogos/cloud_sql/v8/web-48dp/logo_cloud_sql_color_2x_web_48dp.png",
    USER: "https://fonts.gstatic.com/s/i/googlematerialicons/person/v10/grey600-48dp/1x/gm_person_grey600_48dp.png"
};

function onOpen(e) {
  const ui = SlidesApp.getUi();
  const menu = ui.createMenu('Diagram Generator');
  if (e && e.authMode == ScriptApp.AuthMode.NONE) {
    menu.addItem('Authorize Script', 'showSidebar');
  } else {
    menu.addItem('Generate from Prompt', 'showSidebar');
    menu.addSeparator();
    menu.addItem('Configure...', 'showConfigDialog');
  }
  menu.addToUi();
}

function getOAuthToken() { return ScriptApp.getOAuthToken(); }

function showConfigDialog() {
  const html = HtmlService.createHtmlOutputFromFile('Config.html').setTitle('Configuration').setWidth(400).setHeight(250);
  SlidesApp.getUi().showModalDialog(html, 'Configure API Keys');
}

function showSidebar() {
  const props = PropertiesService.getUserProperties();
  if (!props.getProperty('GCP_PROJECT_ID') || !props.getProperty('ICON_MAP_GCS_BUCKET')) {
    SlidesApp.getUi().alert('Configuration required.');
    showConfigDialog();
    return;
  }
  const html = HtmlService.createHtmlOutputFromFile('Sidebar.html').setTitle('Diagram Generator');
  SlidesApp.getUi().showSidebar(html);
}

function getScriptVersion() {
    Logger.log(`Version: ${SCRIPT_VERSION}`);
    return SCRIPT_VERSION;
}

//==================================================================
// CONFIGURATION
//==================================================================

function saveConfig(config) {
  PropertiesService.getUserProperties().setProperties({
    'GCP_PROJECT_ID': config.gcpProjectId,
    'ICON_MAP_GCS_BUCKET': config.gcsBucket
  });
  return { success: true, message: 'Configuration saved!' };
}

function loadConfig() {
  const props = PropertiesService.getUserProperties();
  return { gcpProjectId: props.getProperty('GCP_PROJECT_ID') || '', gcsBucket: props.getProperty('ICON_MAP_GCS_BUCKET') || '' };
}

//==================================================================
// CORE LOGIC
//==================================================================

function getIconMap(iconMapUrl) {
  const cacheKey = 'ICON_MAP_V7_' + iconMapUrl;
  const cache = CacheService.getScriptCache();
  let cachedMap = cache.get(cacheKey);
  if (cachedMap) return JSON.parse(cachedMap);

  try {
    const resp = UrlFetchApp.fetch(iconMapUrl, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error("Map fetch failed.");
    const mapJson = resp.getContentText();
    try { cache.put(cacheKey, mapJson, 3600); } catch (e) {}
    return JSON.parse(mapJson);
  } catch (e) {
    Logger.log("Error getting icon map: " + e.message);
    return {};
  }
}

let CURRENT_ICON_ASSIGNMENTS = {};

function getMermaidCode(userPrompt, gcpProjectId, iconMap) {
  const region = "us-central1";
  const apiUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/${region}/publishers/google/models/${MODEL_ID}:generateContent`;

  const mapEntries = Object.entries(iconMap);
  const limitedEntries = mapEntries.length > 1000 ? mapEntries.slice(0, 1000) : mapEntries;
  
  const promptKeywords = userPrompt.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const relevantIcons = {};
  ['cloud_function', 'pubsub', 'storage', 'bigquery', 'vertex', 'gemini', 'sms', 'user', 'compute', 'database', 'k8s', 'api'].forEach(k => {
     for(const [key, val] of mapEntries) {
         if (key.toLowerCase().includes(k) && !relevantIcons[key]) relevantIcons[key] = val.description;
     }
  });
  let count = Object.keys(relevantIcons).length;
  for (const [key, val] of limitedEntries) {
      if (count >= 300) break; 
      if (!relevantIcons[key]) {
           const desc = (val.description || '').toLowerCase();
           if (promptKeywords.some(w => w.length > 3 && (key.includes(w) || desc.includes(w)))) {
               relevantIcons[key] = val.description;
               count++;
           }
      }
  }

  const availableIconsList = Object.entries(relevantIcons)
    .map(([key, desc]) => `  "${key}": "${(desc || '').replace(/"/g, '\"')}"`) 
    .join(',\n');

  const systemPrompt = `
You are a Google Cloud architecture diagram assistant.
1. Identify entities and interactions. Consolidate redundant ones.
2. Select the BEST icon key for each entity from the 'Available Icons'.

Output JSON with two keys:
-