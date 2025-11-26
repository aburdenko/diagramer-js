//==================================================================
// ADD-ON BOILERPLATE
//==================================================================

const SCRIPT_VERSION = "8.2.0"; // Final stable version with smaller cards

function onOpen(e) {
  const menu = SlidesApp.getUi().createMenu('Diagram Generator');
  if (e && e.authMode == ScriptApp.AuthMode.NONE) {
    menu.addItem('Authorize Script', 'showSidebar');
  } else {
    menu.addItem('Generate from Prompt', 'showSidebar');
    menu.addSeparator();
    menu.addItem('Configure...', 'showConfigDialog');
  }
  menu.addToUi();
}

function showSidebar() {
  const props = PropertiesService.getUserProperties();
  if (!props.getProperty('GCP_PROJECT_ID')) {
    SlidesApp.getUi().alert('Configuration required. Please set your Google Cloud Project ID via the "Configure..." menu.');
    showConfigDialog();
    return;
  }
  const html = HtmlService.createHtmlOutputFromFile('Sidebar.html').setTitle('Diagram Generator ' + SCRIPT_VERSION);
  SlidesApp.getUi().showSidebar(html);
}

function showConfigDialog() {
  const html = HtmlService.createHtmlOutputFromFile('Config.html').setTitle('Configuration').setWidth(400).setHeight(250);
  SlidesApp.getUi().showModalDialog(html, 'Configure API Keys');
}

function getOAuthToken() { return ScriptApp.getOAuthToken(); }
function getScriptVersion() { return SCRIPT_VERSION; }

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
  return {
    gcpProjectId: props.getProperty('GCP_PROJECT_ID') || '',
    modelId: props.getProperty('SELECTED_MODEL') || 'gemini-2.5-flash',
    lastPrompt: props.getProperty('LAST_PROMPT') || ''
  };
}

//==================================================================
// CORE LOGIC
//==================================================================

let CURRENT_ICON_ASSIGNMENTS = {};
const ICON_MAP_URL = "https://storage.googleapis.com/icon-map/icon_map.json";

const FALLBACK_ICONS = {
    GENERIC: "https://www.gstatic.com/images/branding/product/2x/google_cloud_48dp.png",
    USER: "https://fonts.gstatic.com/s/i/googlematerialicons/person/v10/grey600-48dp/1x/gm_person_grey600_48dp.png"
};

/**
 * Fetches the master icon map from a public GCS bucket. Caching is removed due to size limits.
 */
function getIconMap() {
  try {
    Logger.log('Fetching icon map from GCS.');
    const resp = UrlFetchApp.fetch(ICON_MAP_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error(`Map fetch failed with code: ${resp.getResponseCode()}`);
    }
    const mapJson = resp.getContentText();
    return JSON.parse(mapJson);
  } catch (e) {
    Logger.log(`Error getting icon map: ${e.message}. Returning empty map.`);
    return {};
  }
}

/**
 * Calls the Gemini API to get Mermaid code and icon suggestions for a user prompt.
 */
function getMermaidCode(userPrompt, gcpProjectId, modelId, iconMap) {
  Logger.log(`getMermaidCode START: modelId=${modelId}, projectId=${gcpProjectId}`);
  const region = "us-central1";
  const apiUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${gcpProjectId}/locations/${region}/publishers/google/models/${modelId}:generateContent`;
  
  const prioritizedIcons = ['function', 'run', 'compute', 'storage', 'sql', 'bigquery', 'vertex', 'gemini', 'pubsub', 'dataflow', 'spanner', 'bucket', 'api', 'mobile', 'smartphone', 'gateway', 'user', 'database'];
  const relevantIcons = {};
  for (const key in iconMap) {
      if (prioritizedIcons.some(p => key.includes(p))) {
        relevantIcons[key] = iconMap[key].name || iconMap[key].description || '';
      }
  }

  const systemPrompt = `You are a Google Cloud architecture diagram assistant. Analyze the user request to identify components. Select the MOST ACCURATE icon key for each component from the 'Available Icons'. Output JSON with two keys: "icon_map_suggestions" (an object mapping Entity ID -> Icon Key) and "mermaid_code" (standard Mermaid graph LR syntax). Use simple IDs (e.g., User, DB, MobileApp), and put functional roles in labels (e.g., "Data Warehouse"). Do not put product names in labels. Structure: NodeID["Functional Label"]. Available Icons:
{${JSON.stringify(relevantIcons, null, 2)}}`;

  const payload = {
    "system_instruction": { "parts": [{ "text": systemPrompt }] },
    "generationConfig": { "responseMimeType": "application/json", "temperature": 0.0, "seed": 42 },
    "contents": [{ "role": "user", "parts": [{ "text": userPrompt }] }]
  };
  const options = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), headers: { 'Authorization': 'Bearer ' + getOAuthToken() }, muteHttpExceptions: true };

  Logger.log(`Fetching Mermaid code from Gemini API at: ${apiUrl}`);
  const response = UrlFetchApp.fetch(apiUrl, options);
  const responseText = response.getContentText();
  if (response.getResponseCode() !== 200) {
    Logger.log(`Gemini API Error Response: ${responseText}`);
    throw new Error(`Gemini API Error (${response.getResponseCode()}): Check script logs.`);
  }

  try {
     const rawOutput = JSON.parse(responseText).candidates?.[0]?.content?.parts?.[0]?.text;
     Logger.log(`Raw JSON output from Gemini: ${rawOutput}`);
     const parsedJson = JSON.parse(rawOutput.replace(/```json|```/g, '').trim());
     CURRENT_ICON_ASSIGNMENTS = parsedJson.icon_map_suggestions || {};
     return parsedJson.mermaid_code || "";
  } catch (e) {
     Logger.log(`Failed to parse JSON from Gemini. Raw text was: ${responseText}`);
     throw new Error("Invalid JSON response from Gemini. Check logs for details.");
  }
}

/**
 * Parses Mermaid code into a structured format of entities and connections.
 */
function parseMermaid(mermaidCode) {
    Logger.log('Parsing Mermaid:\n' + mermaidCode);
    const entitiesMap = new Map();
    const connections = [];

    const parseNodeStr = (nodeStr) => {
        if (!nodeStr) return null;
        const s = nodeStr.trim();
        let match = s.match(/^(\w+)(?:["']([^"']*)["'])(?::::(\w+))?$/);
        if (!match) {
            match = s.match(/^(\w+)(?:\s*"([^"]*)")?(?::::(\w+))?$/);
        }
        if (!match) {
            match = s.match(/^(\w+)(?::::(\w+))?$/);
        }
        if (!match) return null;
        
        const id = match[1];
        if (['graph', 'LR', 'TD'].includes(id)) return null;

        if (!entitiesMap.has(id)) {
            const label = match[2] || id;
            const icon = match[3] || CURRENT_ICON_ASSIGNMENTS[id] || 'default';
            entitiesMap.set(id, { id, label, icon });
             Logger.log(`Parsed Node: ID=${id}, Label=${label}, Icon=${icon}`);
        }
        return id;
    };

    const lines = mermaidCode.split('\n');
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('graph')) continue;

        const arrowMatch = trimmedLine.match(/--\s*(.*)\s*-->/);
        if (arrowMatch) {
            const fromStr = trimmedLine.substring(0, arrowMatch.index);
            const toStr = trimmedLine.substring(arrowMatch.index + arrowMatch[0].length);
            const labelContent = arrowMatch[1].trim();
            const label = (labelContent.startsWith('"') && labelContent.endsWith('"')) ? labelContent.substring(1, labelContent.length - 1).trim() : labelContent;
            
            const fromId = parseNodeStr(fromStr);
            const toId = parseNodeStr(toStr);

            if (fromId && toId) {
                connections.push({ from: fromId, to: toId, label: label });
                Logger.log(`Parsed Connection: ${fromId} --"${label}"--> ${toId}`);
            }
        } else {
            parseNodeStr(trimmedLine);
        }
    }

    for (const node of entitiesMap.values()) {
        if (node.icon === 'default') {
            const lowerId = node.id.toLowerCase();
            const lowerLabel = node.label.toLowerCase();
            let newIcon = null;
            if (lowerId.includes('mobile') || lowerLabel.includes('mobile')) newIcon = 'smartphone';
            else if (lowerId.includes('user') || lowerLabel.includes('user')) newIcon = 'person';
            else if (lowerId.includes('database') || lowerLabel.includes('db')) newIcon = 'database';
            if (newIcon) {
                node.icon = newIcon;
                Logger.log(`Intelligent assignment: Node "${node.id}" icon updated to "${newIcon}".`);
            }
        }
    }

    const entities = Array.from(entitiesMap.values());
    Logger.log(`parseMermaid END: Found ${entities.length} entities and ${connections.length} connections.`);
    return { entities, connections };
}


/**
 * Calculates node positions for the diagram.
 */
function generateLayoutFromMermaid(parsedData, slideWidth, slideHeight) {
  Logger.log(`generateLayoutFromMermaid START: Generating layout for ${parsedData.entities.length} entities.`);
  const { entities, connections } = parsedData;
  const CARD_W = 140, CARD_H = 60; // Using smaller cards
  
  const nodes = {};
  entities.forEach(e => nodes[e.id] = { ...e, children: [], parents: [], level: 0, x:0, y:0, width: CARD_W, height: CARD_H });
  
  connections.forEach(c => {
    if (nodes[c.from] && nodes[c.to]) {
      nodes[c.from].children.push(c.to);
      nodes[c.to].parents.push(c.from);
    }
  });

  // Simple hierarchical assignment from original version
  for (let i = 0; i < 20; i++) {
      let changed = false;
      for (const id in nodes) {
          const node = nodes[id];
          if (node.parents.length > 0) {
               const maxParentLevel = Math.max(...node.parents.map(pId => nodes[pId].level));
               if (maxParentLevel + 1 > node.level) {
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
      // Dynamic spacing calculation that fits to slide width
      const availableWidth = slideWidth - 100; // 50px margin on each side
      const hSpacing = (numColumns > 1) ? (availableWidth - (numColumns * CARD_W)) / (numColumns - 1) : 0;
      
      const totalWidth = (numColumns * CARD_W) + Math.max(0, numColumns - 1) * hSpacing;
      const startX = (slideWidth - totalWidth) / 2;

      uniqueLevels.forEach((level, colIndex) => {
          const levelNodes = levels[level];
          const availableHeight = slideHeight - 100; // 50px margin
          const vSpacing = (levelNodes.length > 1) ? (availableHeight - (levelNodes.length * CARD_H)) / (levelNodes.length - 1) : 0;
          const totalHeight = (levelNodes.length * CARD_H) + Math.max(0, levelNodes.length - 1) * vSpacing;
          let currentY = (slideHeight - totalHeight) / 2;
          const currentX = startX + colIndex * (CARD_W + hSpacing);
          
          levelNodes.forEach((node) => {
              node.x = currentX;
              node.y = currentY;
              currentY += CARD_H + vSpacing;
          });
      });
  }
  const layoutResult = { entities: Object.values(nodes), connections };
  Logger.log(`generateLayoutFromMermaid END: Layout calculation complete.`);
  return layoutResult;
}

/**
 * Gets the attachment points for a node.
 */
function getCardAttachmentPoints(node) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  return {
    center: { x: centerX, y: centerY }, left: { x: node.x, y: centerY },
    right: { x: node.x + node.width, y: centerY }, top: { x: centerX, y: node.y },
    bottom: { x: centerX, y: node.y + node.height }
  };
}

/**
 * Draws a single node on the slide.
 */
function drawNode(slide, node, iconUrl) {
    const card = slide.insertShape(SlidesApp.ShapeType.ROUND_RECTANGLE, node.x, node.y, node.width, node.height);
    card.getFill().setSolidFill('#FFFFFF');
    const border = card.getBorder();
    border.setWeight(1);
    border.getLineFill().setSolidFill('#DADCE0');

    const iconSize = 32, margin = 12;
    try {
        if (iconUrl) {
            slide.insertImage(iconUrl, node.x + margin, node.y + (node.height - iconSize)/2, iconSize, iconSize);
        }
    } catch (e) { Logger.log(`Could not insert image for node ${node.id} from URL ${iconUrl}. Error: ${e.message}`); } 

    const textX = node.x + iconSize + (margin * 2);
    const textW = Math.max(1, node.width - (iconSize + (margin * 3)));
    
    if (typeof node.label === 'string' && node.label.trim().length > 0) {
      const titleBox = slide.insertTextBox(node.label, textX, node.y + 10, textW, 25); // Adjusted Y and Height
      const tStyle = titleBox.getText().getTextStyle();
      tStyle.setFontSize(9).setBold(true).setForegroundColor('#202124').setFontFamily('Arial');
      titleBox.getFill().setTransparent();
      titleBox.getBorder().setTransparent();
    }
    
    // Subtitle (Product Name)
    if (typeof productName === 'string' && productName.trim().length > 0) {
        const subBox = slide.insertTextBox(productName, textX, node.y + 35, textW, 25); // Adjusted Y and Height
        const sStyle = subBox.getText().getTextStyle();
        sStyle.setFontSize(8).setBold(false).setForegroundColor('#5F6368').setFontFamily('Arial');
        subBox.getFill().setTransparent();
        subBox.getBorder().setTransparent();
    }
}

/**
 * Renders the full diagram on a new slide.
 */
function performRender(mermaidCode, iconMap) {
    const plan = generateLayoutFromMermaid(parseMermaid(mermaidCode), 720, 405);
    if (!plan.entities || plan.entities.length === 0) throw new Error("Parsing failed: No entities found to render.");

    const pres = SlidesApp.getActivePresentation();
    const slide = pres.insertSlide(0, pres.getLayouts().find(l => l.getLayoutName() === 'BLANK') || pres.getLayouts()[0]);
    
    // Pass 1: Draw Connections and Labels (based on original working code)
    Logger.log("--- Starting v5.5.0 style Render ---");

    plan.connections.forEach(c => {
        const from = plan.entities.find(e => e.id === c.from);
        const to = plan.entities.find(e => e.id === c.to);
        if (from && to) {
            // Use the original, simple, right-to-left coordinate logic from v5.5.0
            let x1 = from.x + from.width;
            let y1 = from.y + from.height / 2;
            let x2 = to.x;
            let y2 = to.y + to.height / 2;

            if (to.x > from.x + 20) { x1 = from.x + from.width; x2 = to.x; }

            Logger.log(`v5.5.0-style: Drawing line for ${c.from} -> ${c.to} from (${x1},${y1}) to (${x2},${y2})`);
            const line = slide.insertLine(SlidesApp.LineCategory.STRAIGHT, x1, y1, x2, y2);
            line.getLineFill().setSolidFill('#4284F3');
            line.setWeight(2);
            line.setEndArrow(SlidesApp.ArrowStyle.STEALTH_ARROW);
            line.sendToBack(); // The original, working z-order call

            if (c.label && c.label.trim().length > 0) {
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;
                const labelTb = slide.insertTextBox(c.label, midX - 50, midY - 15, 100, 30);
                labelTb.getText().getTextStyle().setFontSize(7).setForegroundColor('#1967D1'); // Changed color slightly for contrast
                labelTb.getFill().setTransparent(); // Make transparent
                labelTb.getBorder().setTransparent();
            }
        } else {
            Logger.log(`v5.5.0-style: Could not find 'from' or 'to' node for connection: ${c.from}-->${c.to}`);
        }
    });

    // Pass 2: Draw Nodes (on top of connections and labels)
    plan.entities.forEach(e => {
       const iconEntry = iconMap[e.icon] || iconMap['default'];
       const iconUrl = iconEntry ? iconEntry.url : FALLBACK_ICONS.GENERIC;
       Logger.log(`v5.5.0-style: Drawing node ${e.id}`);
       drawNode(slide, e, iconUrl);
    });
}


/**
 * Main function called from UI to generate a diagram from a prompt.
 */
function generateDiagram(userPrompt, modelId, returnMarkupOnly) {
  const props = PropertiesService.getUserProperties();
  const projectId = props.getProperty('GCP_PROJECT_ID');
  if (!projectId) return { success: false, message: 'Configuration missing: Project ID.' };

  try {
    props.setProperty('LAST_PROMPT', userPrompt);
    CURRENT_ICON_ASSIGNMENTS = {};
    const iconMap = getIconMap();
    const mermaidCode = getMermaidCode(userPrompt, projectId, modelId, iconMap);

    if (returnMarkupOnly) {
        return { success: true, mermaidCode: mermaidCode, iconMap: CURRENT_ICON_ASSIGNMENTS };
    }

    performRender(mermaidCode, iconMap);
    return { success: true, message: "Diagram generated successfully." };
  } catch (e) {
    Logger.log(`FATAL in generateDiagram: ${e.stack}`);
    return { success: false, message: `Error: ${e.message}. Check script logs for details.` };
  }
}

/**
 * Main function called from UI to render a diagram from existing Mermaid code.
 */
function renderMermaid(mermaidCode, iconMapJson) {
    try {
        if (iconMapJson) {
            CURRENT_ICON_ASSIGNMENTS = JSON.parse(iconMapJson);
        } else {
            CURRENT_ICON_ASSIGNMENTS = {};
        }
        const iconMap = getIconMap();
        performRender(mermaidCode, iconMap);
        return { success: true, message: "Rendered successfully." };
    } catch (e) {
        Logger.log(`FATAL in renderMermaid: ${e.stack}`);
        return { success: false, message: `Render Error: ${e.message}. Check script logs for details.` };
    }
}
