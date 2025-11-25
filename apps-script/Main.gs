//==================================================================
// ADD-ON BOILERPLATE
//==================================================================

// Public map requested
const ICON_MAP_URL = "https://storage.googleapis.com/icon-map/icon_map.json"; 

const FALLBACK_ICONS = {
    GENERIC: "https://www.gstatic.com/images/branding/product/2x/google_cloud_48dp.png",
    COMPUTE: "https://fonts.gstatic.com/s/i/productlogos/compute_engine/v8/web-48dp/logo_compute_engine_color_2x_web_48dp.png",
    STORAGE: "https://fonts.gstatic.com/s/i/productlogos/cloud_storage/v8/web-48dp/logo_cloud_storage_color_2x_web_48dp.png",
    DATABASE: "https://fonts.gstatic.com/s/i/productlogos/cloud_sql/v8/web-48dp/logo_cloud_sql_color_2x_web_48dp.png",
    USER: "https://fonts.gstatic.com/s/i/googlematerialicons/person/v10/grey600-48dp/1x/gm_person_grey600_48dp.png"
};

const SCRIPT_VERSION = "5.5.0"; // Complete parser rewrite for stability.

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
  if (!props.getProperty('GCP_PROJECT_ID')) {
    SlidesApp.getUi().alert('Configuration required (Project ID).');
    showConfigDialog();
    return;
  }
  const html = HtmlService.createHtmlOutputFromFile('Sidebar.html').setTitle('Diagram Generator');
  SlidesApp.getUi().showSidebar(html);
}

function getScriptVersion() {
    return SCRIPT_VERSION;
}

//==================================================================
// CONFIGURATION
//==================================================================

function saveConfig(config) {
  PropertiesService.getUserProperties().setProperties({
    'GCP_PROJECT_ID': config.gcpProjectId,
    'SELECTED_MODEL': config.modelId
  });
  return { success: true, message: 'Configuration saved!' };
}

function loadConfig() {
  const props = PropertiesService.getUserProperties();
  return { gcpProjectId: props.getProperty('GCP_PROJECT_ID') || '',
           modelId: props.getProperty('SELECTED_MODEL') || 'gemini-1.5-flash-latest' };
}

//==================================================================
// CORE LOGIC
//==================================================================

function getIconMap() {
  const cacheKey = 'ICON_MAP_PUBLIC_V1';
  const cache = CacheService.getScriptCache();
  let cachedMap = cache.get(cacheKey);
  if (cachedMap) return JSON.parse(cachedMap);
  try {
    const resp = UrlFetchApp.fetch(ICON_MAP_URL, { muteHttpExceptions: true });
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

function getMermaidCode(userPrompt, gcpProjectId, modelId, iconMap) {
  Logger.log(`getMermaidCode START: modelId=${modelId}, projectId=${gcpProjectId}`);
  const region = "us-central1";
  const apiUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/${region}/publishers/google/models/${modelId}:generateContent`;
  // Filter icons to fit in context window
  const mapEntries = Object.entries(iconMap);
  const limitedEntries = mapEntries.length > 1500 ? mapEntries.slice(0, 1500) : mapEntries;
  
  const promptKeywords = userPrompt.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  const relevantIcons = {};
  
  // Prioritize common cloud services
  ['function', 'run', 'compute', 'storage', 'sql', 'bigquery', 'vertex', 'gemini', 'pubsub', 'dataflow', 'spanner', 'bucket', 'api'].forEach(k => {
     for(const [key, val] of mapEntries) {
         if (key.toLowerCase().includes(k) && !relevantIcons[key]) relevantIcons[key] = val.name || val.description;
     }
  });
  // Add keyword matches
  let count = Object.keys(relevantIcons).length;
  for (const [key, val] of limitedEntries) {
      if (count >= 400) break; 
      if (!relevantIcons[key]) {
           const desc = (val.description || val.name || '').toLowerCase();
           if (promptKeywords.some(w => w.length > 3 && (key.includes(w) || desc.includes(w)))) {
               relevantIcons[key] = val.name || val.description;
               count++;
           }
      }
  }
  const availableIconsList = Object.entries(relevantIcons)
    .map(([key, desc]) => `  "${key}": "${(desc || '').replace(/"/g, '\\"')}"`) 
    .join(',\n');

  const systemPrompt = `
You are a Google Cloud architecture diagram assistant.
1. Analyze the user request to identify components.
2. Select the MOST ACCURATE icon key for each component from the 'Available Icons'.
3. Output Mermaid JS code.

Output JSON with two keys:
- "icon_map_suggestions": Object mapping Entity ID -> Icon Key.
- "mermaid_code": standard Mermaid graph LR.
    - IDs must be simple (e.g., A, B, User, DB).
    - Labels must be the functional role (e.g., "Data Warehouse", "Ingestion").
    - DO NOT put the product name in the Label; the Icon Key handles that.
    - Structure: NodeID["Functional Label"]

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

  Logger.log(`Fetching Mermaid code from Gemini API at: ${apiUrl}`);
  const response = UrlFetchApp.fetch(apiUrl, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode !== 200) {
    Logger.log(`Gemini API Error Response (Code ${responseCode}): ${responseText}`);
    throw new Error(`Gemini API Error (${responseCode}): Check logs for full response.`);
  }

  let parsedJson;
  try {
     const rawOutput = JSON.parse(responseText).candidates?.[0]?.content?.parts?.[0]?.text;
     Logger.log(`Raw JSON output from Gemini: ${rawOutput}`);
     parsedJson = JSON.parse(rawOutput.replace(/```json|```/g, '').trim());
  } catch (e) {
     Logger.log(`Failed to parse JSON from Gemini. Raw text was: ${responseText}`);
     throw new Error("Invalid JSON response from Gemini. Check logs for details.");
  }

  CURRENT_ICON_ASSIGNMENTS = parsedJson.icon_map_suggestions || {};
  const mermaidCode = parsedJson.mermaid_code || "";
  return mermaidCode.replace(/```mermaid|```/g, '').trim();
}

function parseMermaid(mermaidCode) {
  Logger.log('Parsing Mermaid:\n' + mermaidCode);
  const entitiesMap = new Map();
  const connections = [];

  // Regex for nodes: ID["Label"]:::icon OR ID[Label]:::icon OR ID:::icon OR ID
  const nodeDefinitionRegex = /(\w+)(?:\["([^"]*)"\])?(?:::(\w+))?/g;
  let remainingMermaidCode = mermaidCode;

  // First pass: extract all explicit node definitions
  let match;
  // Use a temporary array to store definitions to process after regex.exec loop
  const tempNodeDefinitions = [];
  while ((match = nodeDefinitionRegex.exec(mermaidCode)) !== null) {
      tempNodeDefinitions.push({
          fullMatch: match[0],
          id: match[1],
          label: match[2],
          icon: match[3]
      });
  }

  // Process extracted node definitions and clean mermaid code
  for (const nodeDef of tempNodeDefinitions) {
      const id = nodeDef.id;
      if (['graph','LR','TD'].includes(id)) continue; // Skip graph definition keywords
      
      const label = nodeDef.label || id; // If no label, use ID
      const icon = nodeDef.icon || CURRENT_ICON_ASSIGNMENTS[id] || 'default';
      
      if (!entitiesMap.has(id)) {
          entitiesMap.set(id, { id, label, icon });
          Logger.log(`Parsed explicit node: ${id}, Label: "${label}", Icon: "${icon}"`);
      }
      // Replace only the first occurrence for now; further logic might be needed for complex cases
      remainingMermaidCode = remainingMermaidCode.replace(nodeDef.fullMatch, id);
  }


  // Second pass: Parse connections from the processed code
  // The processed code should now mostly contain only IDs and connection arrows/labels
  // This regex looks for: ID --"label"--> ID, ID --> ID, ID -- ID
  const connectionRegex = /(\w+)\s*(?:--\s*"?([^"]*)"?\s*--|\s*--|\s*-->|\s*-+\s*)\s*(\w+)/g;

  while ((match = connectionRegex.exec(remainingMermaidCode)) !== null) {
      const from = match[1];
      const label = match[2] || ''; // Connection label if present (from the group capturing between --"label"-- or --label--)
      const to = match[3];

      connections.push({ from, to, label });
      Logger.log(`Parsed connection: ${from} --"${label}"--> ${to}`);

      // Ensure nodes involved in connections exist, even if not explicitly defined
      if (!entitiesMap.has(from)) {
        entitiesMap.set(from, { id: from, label: from, icon: 'default' });
        Logger.log(`Added implicit node from connection (from): ${from}`);
      }
      if (!entitiesMap.has(to)) {
        entitiesMap.set(to, { id: to, label: to, icon: 'default' });
        Logger.log(`Added implicit node from connection (to): ${to}`);
      }
  }
  
  const entities = Array.from(entitiesMap.values());
  Logger.log(`parseMermaid END: Found ${entities.length} entities and ${connections.length} connections.`);
  return { entities, connections };
}


function generateLayoutFromMermaid(parsedData, slideWidth, slideHeight) {
  Logger.log(`generateLayoutFromMermaid START: Generating layout for ${parsedData.entities.length} entities.`);
  const { entities, connections } = parsedData;
  // CARD DIMENSIONS (Wider for Product Cards)
  const CARD_W = 160;
  const CARD_H = 70;
  
  const nodes = {};
  entities.forEach(e => nodes[e.id] = { ...e, children: [], parents: [], level: 0, x:0, y:0, width: CARD_W, height: CARD_H });
  
  connections.forEach(c => {
    if (nodes[c.from] && nodes[c.to]) {
      nodes[c.from].children.push(c.to);
      nodes[c.to].parents.push(c.from);
    }
  });

  // Simple hierarchical assignment
  const MAX_LEVEL = 8;
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

  const levels = {};
  for (const id in nodes) {
    if (!levels[nodes[id].level]) levels[nodes[id].level] = [];
    levels[nodes[id].level].push(nodes[id]);
  }

  const uniqueLevels = Object.keys(levels).map(Number).sort((a,b) => a-b);
  const numColumns = uniqueLevels.length;

  if (numColumns > 0) {
      const hSpacing = 240; // Space between columns
      const vSpacing = 110; // Space between rows
      
      const totalWidth = (numColumns * CARD_W) + ((numColumns - 1) * (hSpacing - CARD_W));
      const startX = Math.max(50, (slideWidth - totalWidth) / 2);

      uniqueLevels.forEach((level, colIndex) => {
          const levelNodes = levels[level];
          const colHeight = (levelNodes.length * CARD_H) + ((levelNodes.length - 1) * (vSpacing - CARD_H));
          let currentY = Math.max(50, (slideHeight - colHeight) / 2);
          const currentX = startX + (colIndex * hSpacing);
          levelNodes.forEach((node) => {
              node.x = currentX;
              node.y = currentY;
              currentY += vSpacing;
          });
      });
  }
  const layoutResult = { entities: Object.values(nodes), connections };
  Logger.log(`generateLayoutFromMermaid END: Layout calculation complete.`);
  return layoutResult;
}

function drawNode(slide, node, iconUrl, productName) {
    // 1. Background Card
    const card = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, node.x, node.y, node.width, node.height);
    card.getFill().setSolidFill('#FFFFFF');
    
    // [FIX] Correctly set border properties without chaining
    const border = card.getBorder();
    border.setWeight(1);
    border.getLineFill().setSolidFill('#DADCE0'); // Google Grey

    // 2. Icon (Left aligned)
    const iconSize = 32;
    const margin = 12;
    try {
        if (iconUrl) {
            slide.insertImage(iconUrl, node.x + margin, node.y + (node.height - iconSize)/2, iconSize, iconSize);
        }
    } catch (e) { /* Ignore missing icon */ }

    // 3. Text Block
    const textX = node.x + iconSize + (margin * 2);
    // [BUGFIX] Ensure text width is never negative, which can cause a "height should not be zero" error.
    const textW = Math.max(1, node.width - (iconSize + (margin * 3)));
    
    // Title (Role/Label)
    if (typeof node.label === 'string' && node.label.trim().length > 0) {
      const titleBox = slide.insertTextBox(node.label, textX, node.y + 12, textW, 20);
      const tStyle = titleBox.getText().getTextStyle();
      tStyle.setFontSize(9).setBold(true).setForegroundColor('#202124').setFontFamily('Arial');
      titleBox.getFill().setTransparent();
      titleBox.getBorder().setTransparent();
    }
    
    // Subtitle (Product Name)
    if (typeof productName === 'string' && productName.trim().length > 0) {
        const subBox = slide.insertTextBox(productName, textX, node.y + 32, textW, 20);
        const sStyle = subBox.getText().getTextStyle();
        sStyle.setFontSize(8).setBold(false).setForegroundColor('#5F6368').setFontFamily('Arial');
        subBox.getFill().setTransparent();
        subBox.getBorder().setTransparent();
    }
}

function performRender(mermaidCode) {
    const iconMap = getIconMap();
    const plan = generateLayoutFromMermaid(parseMermaid(mermaidCode), 720, 405);

    if (!plan.entities || plan.entities.length === 0) {
      throw new Error("Parsing failed: No entities found to render.");
    }

    const pres = SlidesApp.getActivePresentation();
    const slide = pres.insertSlide(0, pres.getLayouts().find(l => l.getLayoutName() === 'BLANK') || pres.getLayouts()[0]);
    
    // Draw Connections (Back)
    plan.connections.forEach(c => {
        const from = plan.entities.find(e => e.id === c.from);
        const to = plan.entities.find(e => e.id === c.to);
        if (from && to) {
            let x1 = from.x + from.width; let y1 = from.y + from.height/2;
            let x2 = to.x; let y2 = to.y + to.height/2;
            
            if (to.x > from.x + 20) { x1 = from.x + from.width; x2 = to.x; }
            
            Logger.log(`Drawing line from (${x1}, ${y1}) to (${x2}, ${y2})`);
            const line = slide.insertLine(SlidesApp.LineCategory.STRAIGHT, x1, y1, x2, y2);
            line.getLineFill().setSolidFill('#4284F3'); 
            line.setWeight(2);
            line.setEndArrow(SlidesApp.ArrowStyle.STEALTH_ARROW);
            line.sendToBack();
            
            if (c.label && c.label.trim().length > 0) {
                const midX = (x1 + x2) / 2; const midY = (y1 + y2) / 2;
                const labelTb = slide.insertTextBox(c.label, midX - 30, midY - 10, 60, 20);
                labelTb.getText().getTextStyle().setFontSize(7).setForegroundColor('#1967D2');
                labelTb.getFill().setSolidFill('#FFFFFF');
                labelTb.getBorder().setTransparent();
            }
        }
    });

    // Draw Nodes (Front)
    plan.entities.forEach(e => {
       const iconKey = CURRENT_ICON_ASSIGNMENTS[e.id] || 'default';
       const iconEntry = iconMap[iconKey] || iconMap['default'];
       const iconUrl = iconEntry ? iconEntry.url : FALLBACK_ICONS.GENERIC;
       const productName = iconEntry ? (iconEntry.name || iconEntry.title || "") : "";
       drawNode(slide, e, iconUrl, productName);
    });
}

function generateDiagram(userPrompt, modelId, returnMarkupOnly) {
  const props = PropertiesService.getUserProperties();
  const projectId = props.getProperty('GCP_PROJECT_ID');
  
  if (!projectId) return { success: false, message: 'Configuration missing: Project ID.' };

  try {
    CURRENT_ICON_ASSIGNMENTS = {};
    const iconMap = getIconMap();
    const mermaidCode = getMermaidCode(userPrompt, projectId, modelId, iconMap);

    if (returnMarkupOnly) {
        return { success: true, mermaidCode: mermaidCode };
    }

    performRender(mermaidCode);
    return { success: true, message: "Diagram generated successfully." };
  } catch (e) {
    Logger.log(`FATAL in generateDiagram: ${e.stack}`);
    return { success: false, message: `Error: ${e.message}. Check script logs for details.` };
  }
}

function renderMermaid(mermaidCode) {
    try {
        performRender(mermaidCode);
        return { success: true, message: "Rendered successfully." };
    } catch (e) {
        Logger.log(`FATAL in renderMermaid: ${e.stack}`);
        return { success: false, message: `Render Error: ${e.message}. Check script logs for details.` };
    }
}
