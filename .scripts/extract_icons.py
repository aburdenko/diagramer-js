#!/usr/bin/env python3

import os
import sys
import json
import time
import random
import requests
import google.auth
from googleapiclient.discovery import build
from google.cloud import storage
from google.cloud import aiplatform
from vertexai.preview.generative_models import GenerativeModel, Part, GenerationConfig

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/devstorage.full_control",
    "https://www.googleapis.com/auth/cloud-platform"
]

RESUME_STATE_FILE = ".resume_state"

def get_icon_data_from_gemini(model, image_bytes):
    """
    Uses Gemini to identify the image and return a JSON object with name and description.
    """
    image_part = Part.from_data(image_bytes, mime_type="image/png")
    
    prompt_text = """
    You are an icon naming assistant for a cloud architecture diagramming tool.
    Analyze this image and return a JSON object with two fields:
    1. "name": A short, specific, snake_case key for this icon (e.g., 'compute_engine', 'cloud_sql_postgres', 'generic_user_blue').
    2. "description": A very brief (5-10 words) description of what this icon represents visually and semantically.
    """

    generation_config = GenerationConfig(
        response_mime_type="application/json"
    )
    
    max_retries = 2
    base_delay = 2 

    for attempt in range(max_retries + 1):
        try:
            response = model.generate_content(
                [image_part, prompt_text],
                generation_config=generation_config
            )
            data = json.loads(response.text)
            
            # Sanitize the name just in case
            sanitized_name = "".join(c for c in data["name"] if c.isalnum() or c in ('-', '_')).rstrip().lower()
            
            return {
                "name": sanitized_name if sanitized_name else "generic_icon",
                "description": data.get("description", "No description available.")
            }

        except Exception as e:
            error_str = str(e)
            is_rate_limit = "429" in error_str or "ResourceExhausted" in error_str or "Quota" in error_str
            
            if is_rate_limit and attempt < max_retries:
                delay = (base_delay * (2 ** attempt)) + (random.randint(0, 1000) / 1000)
                print(f"  [!] Rate limit hit. Retrying in {delay:.2f}s... (Attempt {attempt + 1}/{max_retries})")
                time.sleep(delay)
                continue
            elif attempt == max_retries and is_rate_limit:
                 print(f"  [!] Failed after {max_retries} retries.")
                 return {"name": "error_rate_limit", "description": "Failed to identify due to rate limits."}
            else:
                print(f"  [!] Gemini Error: {e}")
                return {"name": "error_icon", "description": "Failed to identify."}

# --- State Management (Updated for new map structure) ---
def load_existing_state(output_dir, bucket=None):
    last_index = -1
    icon_map = {}
    state_path = os.path.join(output_dir, RESUME_STATE_FILE)
    if os.path.exists(state_path):
        try:
            with open(state_path, 'r') as f: last_index = int(f.read().strip())
            print(f"Found resume state. Last processed index: {last_index}")
        except: pass

    map_path_local = os.path.join(output_dir, "icon_map.json")
    if bucket:
        try:
             blob = bucket.blob("icon_map.json")
             if blob.exists(): blob.download_to_filename(map_path_local)
        except: pass

    if os.path.exists(map_path_local):
        try:
            with open(map_path_local, 'r') as f: icon_map = json.load(f)
            print(f"Loaded existing icon_map with {len(icon_map)} entries.")
        except: pass
    return last_index, icon_map

def save_incremental_state(output_dir, index, icon_map):
    with open(os.path.join(output_dir, RESUME_STATE_FILE), 'w') as f: f.write(str(index))
    with open(os.path.join(output_dir, "icon_map.json"), 'w') as f: json.dump(icon_map, f, indent=2)
# ---------------------------------------

def main(presentation_id, output_dir):
    creds, project = google.auth.default(scopes=SCOPES)
    if not project: project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not project: sys.exit("Error: Set GOOGLE_CLOUD_PROJECT env var.")
    print(f"Using Project ID: {project}")

    try:
        aiplatform.init(project=project, location="us-central1", credentials=creds)
        # Using 1.5 Flash for speed and cost-effectiveness in this batch process
        
        model_id = "gemini-2.5-flash"
        gemini_model = GenerativeModel(model_id)
        print("Vertex AI initialized.")
    except Exception as e: sys.exit(f"Error initializing Vertex AI: {e}")

    service = build("slides", "v1", credentials=creds)
    gcs_bucket_name = os.environ.get("GCS_UPLOAD_BUCKET")
    bucket = storage.Client(credentials=creds).bucket(gcs_bucket_name) if gcs_bucket_name else None
    if not bucket and not os.path.exists(output_dir): os.makedirs(output_dir)

    last_index, icon_map = load_existing_state(output_dir, bucket)

    try:
        print("Fetching presentation...")
        presentation = service.presentations().get(presentationId=presentation_id).execute()
        all_elements = []
        for i, slide in enumerate(presentation.get("slides", [])):
            for element in slide.get("pageElements", []):
                element["_slide_index"] = i
                all_elements.append(element)
        
        print(f"Found {len(all_elements)} elements. Starting processing...")

        for i, element in enumerate(all_elements):
            if i <= last_index:
                if i % 50 == 0: print(f"Skipping {i}/{len(all_elements)}...")
                continue

            content_url = None
            if "image" in element and "contentUrl" in element["image"]:
                content_url = element["image"]["contentUrl"]
            elif "shape" in element and "shapeProperties" in element["shape"]:
                 sp = element["shape"]["shapeProperties"]
                 if "shapeBackgroundFill" in sp and "stretchedPictureProperties" in sp["shapeBackgroundFill"]:
                     content_url = sp["shapeBackgroundFill"]["stretchedPictureProperties"].get("contentUrl")

            if content_url:
                print(f"--- Processing {i+1}/{len(all_elements)} (Slide {element['_slide_index'] + 1}) ---")
                try:
                    resp = requests.get(content_url, timeout=10)
                    if resp.status_code == 200:
                        time.sleep(0.5) # Rate limit polite pause
                        
                        icon_data = get_icon_data_from_gemini(gemini_model, resp.content)
                        base_name = icon_data["name"]
                        description = icon_data["description"]

                        name = base_name
                        c = 2
                        while name in icon_map:
                            name = f"{base_name}_{c}"
                            c += 1
                        
                        print(f"  Identified: {name} ('{description}')")

                        filename = f"{name}.png"
                        if bucket:
                            bucket.blob(f"{output_dir}/{filename}").upload_from_string(resp.content, content_type="image/png")
                            public_url = f"https://storage.googleapis.com/{gcs_bucket_name}/{output_dir}/{filename}"
                            # NEW MAP STRUCTURE
                            icon_map[name] = {"url": public_url, "description": description}
                            print(f"  Uploaded to GCS")
                        else:
                            with open(os.path.join(output_dir, filename), "wb") as f: f.write(resp.content)
                            # NEW MAP STRUCTURE
                            icon_map[name] = {"url": os.path.join(output_dir, filename), "description": description}
                            print(f"  Saved locally")

                        save_incremental_state(output_dir, i, icon_map)
                except Exception as e:
                     print(f"  [!] Error: {e}")

        print("\n--- Processing Complete ---")
        # Updated default structure
        icon_map["default"] = {"url": "https://placehold.co/60x60/EFEFEF/CCC?text=?", "description": "Default placeholder icon"}
        
        if bucket:
            bucket.blob("icon_map.json").upload_from_string(json.dumps(icon_map, indent=2), content_type="application/json")
            print("Uploaded final icon_map.json to GCS.")
        else:
            with open(os.path.join(output_dir, "icon_map.json"), 'w') as f: json.dump(icon_map, f, indent=2)
            print("Saved final icon_map.json locally.")
        
        if os.path.exists(os.path.join(output_dir, RESUME_STATE_FILE)):
            os.remove(os.path.join(output_dir, RESUME_STATE_FILE))

    except Exception as e:
        print(f"\n[!] Crashed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("Usage: python extract_icons.py <PRESENTATION_ID> <OUTPUT_DIR>")
    main(sys.argv[1], sys.argv[2])