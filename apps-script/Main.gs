//==================================================================
// ADD-ON BOILERPLATE
//==================================================================

const SCRIPT_VERSION = "4.64";
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
    .map(([key, desc]) => `  "${key}": "${(desc || '').replace(/"/g, '\\"')}"`)
    .join(',\n');

  const systemPrompt = `
You are a Google Cloud architecture diagram assistant.
1. Identify entities and interactions. Consolidate redundant ones.
2. Select the BEST icon key for each entity from the 'Available Icons'.

Output JSON with two keys:
- "icon_map_suggestions": Object mapping Entity ID -> Icon Key.
- "mermaid_code": standard Mermaid graph LR.
    - IDs must be single alphanumeric words (NO SPACES, e.g., User, CloudFunc).
    - Use labels for readable names: ID["Human Readable Label"].

Available Icons:
{
${availableIconsList}
}
`;

  const payload = {
    "system_instruction": { "parts": [{ "text": systemPrompt }] },
    "generationConfig": { "responseMimeType": "application/json" },
    "contents": [{ "role": "user", "parts": [{ "text": userPrompt }] }]
  };

  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'payload': JSON.stringify(payload),
    'headers': { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() },
    'muteHttpExceptions': true
  };

  const response = UrlFetchApp.fetch(apiUrl, options);
  if (response.getResponseCode() !== 200) throw new Error('Gemini API Error: ' + response.getContentText());
  
  const apiResponse = JSON.parse(response.getContentText());
  const rawOutput = apiResponse.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawOutput) throw new Error('No content returned from Gemini API.');

  let parsedJson;
  try {
     parsedJson = JSON.parse(rawOutput.replace(/```json|```/g, '').trim());
  } catch (e) {
     throw new Error("Invalid JSON from Gemini.");
  }

  CURRENT_ICON_ASSIGNMENTS = parsedJson.icon_map_suggestions || {};
  let mermaidCode = parsedJson.mermaid_code || "";

  // Standardize Mermaid by injecting :::icon_key
  for (const id in CURRENT_ICON_ASSIGNMENTS) {
      const icon = CURRENT_ICON_ASSIGNMENTS[id];
      const regex = new RegExp(`(${id}\\s*\\[".+?"\\])`, 'g');
      mermaidCode = mermaidCode.replace(regex, `$1:::${icon}`);
  }

  return mermaidCode.replace(/```mermaid|```/g, '').trim();
}

function parseMermaid(mermaidCode) {
  Logger.log('Parsing Mermaid:\n' + mermaidCode);
  const entitiesMap = new Map();
  const connections = [];

  // 1. Node Regex: ID["Label"]:::icon OR ID[Label]:::icon (quotes optional now)
  const nodeRegex = /([a-zA-Z0-9_]+)\s*\["?(.*?)"?\](?::+([a-zA-Z0-9_]+))?/g;
  
  // 2. Connection Regex
  const connectionRegex = /([a-zA-Z0-9_]+)(?:::[a-zA-Z0-9_]+)?\s*[-=.]+(?:\s*["|'](.+?)["|']\s*)?[-=.>]*>\s*([a-zA-Z0-9_]+)(?:::[a-zA-Z0-9_]+)?/g;

  for (const match of mermaidCode.matchAll(nodeRegex)) {
      const id = match[1];
      if (['graph','LR','TD'].includes(id)) continue;
      
      const label = match[2] || id;
      // Priority: 1. Explicit :::icon in markup, 2. Gemini suggestion, 3. Default
      const icon = match[3] || CURRENT_ICON_ASSIGNMENTS[id] || 'default';

      if (!entitiesMap.has(id)) {
          entitiesMap.set(id, { id, label, icon });
          Logger.log(`Parsed Entity: ${id}, Icon: ${icon}`);
      }
  }

  for (const match of mermaidCode.matchAll(connectionRegex)) {
      const from = match[1];
      const to = match[3];
      connections.push({ from, label: match[2] || '', to });
      
      if (!entitiesMap.has(from)) entitiesMap.set(from, { id: from, label: from, icon: 'default' });
      if (!entitiesMap.has(to)) entitiesMap.set(to, { id: to, label: to, icon: 'default' });
  }

  const entities = Array.from(entitiesMap.values());
  Logger.log(`Parsed ${entities.length} entities and ${connections.length} connections.`);
  return { entities, connections };
}

function generateLayoutFromMermaid(parsedData, slideWidth, slideHeight) {
  const { entities, connections } = parsedData;
  const nodes = {};
  entities.forEach(e => nodes[e.id] = { ...e, children: [], parents: [], level: 0, x:0, y:0, width:60, height:60 });
  connections.forEach(c => {
    if (nodes[c.from] && nodes[c.to]) {
      nodes[c.from].children.push(c.to);
      nodes[c.to].parents.push(c.from);
    }
  });

  const MAX_LEVEL = 6;
  for (let i = 0; i < 20; i++) {
      let changed = false;
      for (const id in nodes) {
          const node = nodes[id];
          if (node.parents.length > 0) {
               const maxParentLevel = Math.max(...node.parents.map(pId => nodes[pId].level));
               if (maxParentLevel + 1 > node.level && maxParentLevel + 1 <= MAX_LEVEL) {
                   node.level = maxParentLevel + 1;
                   changed = true;
               }
          }
      }
      if (!changed) break;
  }

  const minLevel = Math.min(...Object.values(nodes).map(n => n.level));
  if (minLevel > 0) Object.values(nodes).forEach(n => n.level -= minLevel);

  const levels = {};
  let maxNodesInColumn = 0;
  for (const id in nodes) {
    if (!levels[nodes[id].level]) levels[nodes[id].level] = [];
    levels[nodes[id].level].push(nodes[id]);
    maxNodesInColumn = Math.max(maxNodesInColumn, levels[nodes[id].level].length);
  }

  const iconSize = 60;
  const marginX = 60;
  const uniqueLevels = Object.keys(levels).map(Number).sort((a,b) => a-b);
  const numColumns = uniqueLevels.length;

  if (numColumns > 0) {
      const hSpacing = Math.min(250, (slideWidth - 2 * marginX) / Math.max(1, numColumns - 1));
      const totalDiagramWidth = (numColumns - 1) * hSpacing + iconSize;
      const startX = Math.max(marginX, (slideWidth - totalDiagramWidth) / 2);

      uniqueLevels.forEach((level, index) => {
          const levelNodes = levels[level];
          const currentX = startX + (index * hSpacing);
          const vSpacing = Math.min(200, (slideHeight - 100) / Math.max(1, levelNodes.length));
          const columnHeight = (levelNodes.length * iconSize) + ((levelNodes.length - 1) * (vSpacing - iconSize));
          let currentY = (slideHeight - columnHeight) / 2;
          
          levelNodes.forEach((node) => {
              node.x = currentX; node.y = currentY; node.width = iconSize; node.height = iconSize;
              currentY += vSpacing;
          });
      });
  }
  return { entities: Object.values(nodes), connections };
}

function getFallbackIconUrl(entity) {
    const label = (entity.label || "").toLowerCase();
    if (label.includes('user') || label.includes('client')) return FALLBACK_ICONS.USER;
    if (label.includes('compute') || label.includes('function')) return FALLBACK_ICONS.COMPUTE;
    if (label.includes('storage') || label.includes('bucket')) return FALLBACK_ICONS.STORAGE;
    if (label.includes('sql') || label.includes('data')) return FALLBACK_ICONS.DATABASE;
    return FALLBACK_ICONS.GENERIC;
}

function drawNode(slide, node, iconUrl) {
    const bg = slide.insertShape(SlidesApp.ShapeType.ELLIPSE, node.x, node.y, node.width, node.height);
    bg.getFill().setSolidFill('#FFFFFF');
    bg.getBorder().setTransparent();

    let icon;
    try {
        icon = slide.insertImage(iconUrl, node.x, node.y, node.width, node.height);
    } catch (e) {
         try { icon = slide.insertImage(getFallbackIconUrl(node), node.x, node.y, node.width, node.height); }
         catch (e2) { /* bg is fallback */ }
    }

    const textBox = slide.insertTextBox(node.label, node.x - 30, node.y + node.height + 5, node.width + 60, 40);
    textBox.getText().getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
    textBox.getText().getTextStyle().setFontSize(8).setBold(true).setForegroundColor('#3C4043').setFontFamily('Arial');
    textBox.getFill().setTransparent();
    textBox.getBorder().setTransparent();
    return { bg, icon, textBox };
}

function performRender(mermaidCode, bucketName) {
    const iconMap = getIconMap(`https://storage.googleapis.com/${bucketName}/icon_map.json`);
    const plan = generateLayoutFromMermaid(parseMermaid(mermaidCode), 720, 405);

    if (!plan.entities.length) throw new Error("No entities found to render.");

    const pres = SlidesApp.getActivePresentation();
    const slide = pres.insertSlide(0, pres.getLayouts().find(l => l.getLayoutName() === 'BLANK') || pres.getLayouts()[0]);
    const textboxesToFront = []; 

    plan.connections.forEach(c => {
        const from = plan.entities.find(e => e.id === c.from);
        const to = plan.entities.find(e => e.id === c.to);
        if (from && to) {
             let x1 = from.x + from.width / 2; let y1 = from.y + from.height / 2;
             let x2 = to.x + to.width / 2; let y2 = to.y + to.height / 2;
             if (to.x > from.x + from.width/2 + 10) { x1 = from.x + from.width; x2 = to.x; }
             else if (from.x > to.x + from.width/2 + 10) { x1 = from.x; x2 = to.x + to.width; }
             else { if (to.y > from.y) { y1 = from.y + from.height; y2 = to.y; } else { y1 = from.y; y2 = to.y + to.height; } }

            if (Math.abs(x1 - x2) < 1) x2 += 1; if (Math.abs(y1 - y2) < 1) y2 += 1;
            const line = slide.insertLine(SlidesApp.LineCategory.BENT, x1, y1, x2, y2);
            line.getLineFill().setSolidFill('#4284F3'); line.setWeight(2);
            line.setEndArrow(SlidesApp.ArrowStyle.STEALTH_ARROW);
            line.sendToBack();

            if (c.label) {
                const midX = (x1 + x2) / 2; const midY = (y1 + y2) / 2;
                const labelTb = slide.insertTextBox(c.label, midX - 40, midY - 12, 80, 25);
                labelTb.getText().getTextStyle().setFontSize(7).setForegroundColor('#4284F3').setFontFamily('Arial');
                labelTb.getText().getParagraphStyle().setParagraphAlignment(SlidesApp.ParagraphAlignment.CENTER);
                labelTb.getFill().setSolidFill('#FFFFFF'); labelTb.getBorder().setTransparent();
                textboxesToFront.push(labelTb);
            }
        }
    });

    plan.entities.forEach(e => {
       let iconEntry = iconMap[e.icon];
       let iconUrl = iconEntry?.url || (typeof iconEntry === 'string' ? iconEntry : null);
       if (!iconUrl) iconUrl = getFallbackIconUrl(e);
       const drawn = drawNode(slide, e, iconUrl);
       textboxesToFront.push(drawn.textBox);
    });

    textboxesToFront.forEach(tb => tb.bringToFront());
}

function generateDiagram(userPrompt, returnMarkupOnly) {
  const props = PropertiesService.getUserProperties();
  const projectId = props.getProperty('GCP_PROJECT_ID');
  const bucket = props.getProperty('ICON_MAP_GCS_BUCKET');
  if (!projectId || !bucket) return { success: false, message: 'Configuration missing.' };

  try {
    CURRENT_ICON_ASSIGNMENTS = {}; 
    const iconMap = getIconMap(`https://storage.googleapis.com/${bucket}/icon_map.json`);
    const mermaidCode = getMermaidCode(userPrompt, projectId, iconMap);

    if (returnMarkupOnly) {
        return { success: true, mermaidCode: mermaidCode };
    }

    performRender(mermaidCode, bucket);
    return { success: true, message: "Diagram generated successfully." };
  } catch (e) {
    Logger.log(e);
    return { success: false, message: `Error: ${e.message}` };
  }
}

function renderMermaid(mermaidCode) {
    const props = PropertiesService.getUserProperties();
    const bucket = props.getProperty('ICON_MAP_GCS_BUCKET');
    if (!bucket) return { success: false, message: 'Configuration missing.' };

    try {
        // Note: Manual render won't have fresh Gemini icon assignments,
        // but the user can now manually add :::icon_key to their markup.
        performRender(mermaidCode, bucket);
        return { success: true, message: "Rendered successfully from markup." };
    } catch (e) {
        Logger.log(e);
        return { success: false, message: `Render Error: ${e.message}` };
    }
}