# Usage: source .scripts/configure.sh

# --- Gemini CLI Installation/Update ---
if ! command -v npm &> /dev/null; then
  echo "Error: npm is not installed. Please install Node.js and npm to continue." >&2
  return 1
fi

echo "Checking for the latest Gemini CLI version..."
LATEST_VERSION=$(npm view @google/gemini-cli version)

if ! command -v gemini &> /dev/null; then
  echo "Gemini CLI not found. Installing the latest version ($LATEST_VERSION)..."
  sudo npm install -g @google/gemini-cli@latest
else
  # Extract version from `npm list`, which is more reliable than `gemini --version`
  INSTALLED_VERSION=$(npm list -g @google/gemini-cli --depth=0 2>/dev/null | grep '@google/gemini-cli' | sed 's/.*@//')
  if [ "$INSTALLED_VERSION" == "$LATEST_VERSION" ]; then
    echo "Gemini CLI is already up to date (version $INSTALLED_VERSION)."
  else
    echo "A new version of Gemini CLI is available."
    echo "Upgrading from version $INSTALLED_VERSION to $LATEST_VERSION..."
    sudo npm install -g @google/gemini-cli@latest
  fi
fi


# --- Environment Configuration ---
# This script now sources its configuration from the .env file in the project root.
ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: Configuration file '$ENV_FILE' not found." >&2
    echo "Please create it by copying from '.env.example' and filling in the values." >&2
    return 1 # Use return instead of exit to allow sourcing to fail gracefully
fi

# Read variables from .env, filter out comments, and export them.
# This pipeline filters out full-line comments, then strips inline comments,
# then exports the remaining VAR=value pairs.
export $(grep -v '^#' "$ENV_FILE" | sed 's/#.*//' | xargs)
export GCS_UPLOAD_BUCKET

# --- Git User Configuration ---
# Set git user.name and user.email if they are defined in the .env file.
if [ -n "$GIT_USER_NAME" ] && [ -n "$GIT_USER_EMAIL" ]; then
  echo "Configuring git user name and email..."
  git config --global user.name "$GIT_USER_NAME"
  git config --global user.email "$GIT_USER_EMAIL"
  git config --global init.defaultBranch main
else
  echo "Skipping git user configuration (GIT_USER_NAME or GIT_USER_EMAIL not set in .env)."
fi

# --- Google Credentials Setup ---
# This section determines the GCP Project ID and sets up credentials.
# The order of precedence is:
# 1. Service Account specified in .env (SERVICE_ACCOUNT_KEY_FILE)
# 2. User's Application Default Credentials (ADC) via gcloud

echo "--- Configuring Google Cloud Authentication & Project ---"

# --- Step 1: Check for Service Account ---
# The path to the service account key file should be set in the .env file
# using the standard GOOGLE_APPLICATION_CREDENTIALS variable.
if [ -n "$GOOGLE_APPLICATION_CREDENTIALS" ] && [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ]; then
  echo "Service Account key found at '$GOOGLE_APPLICATION_CREDENTIALS'. Using it for authentication."
  # If PROJECT_ID is not already set in .env, extract it from the SA key.
  if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID=$(jq -r .project_id "$GOOGLE_APPLICATION_CREDENTIALS")
    if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" == "null" ]; then
      echo "ERROR: Could not extract project_id from service account key file." >&2
      echo "Please set PROJECT_ID in your .env file." >&2
      return 1
    fi
    echo "Inferred PROJECT_ID from Service Account: $PROJECT_ID"
  fi
else
  # --- Step 2: Fallback to Application Default Credentials (ADC) ---
  echo "Service Account key not found or not specified. Falling back to gcloud Application Default Credentials."
  unset GOOGLE_APPLICATION_CREDENTIALS

  # Ensure user is logged in for ADC. This avoids re-prompting on every `source`.
  if ! gcloud auth application-default print-access-token &>/dev/null; then
    echo "User is not logged in for ADC. Running 'gcloud auth application-default login'..."
    if ! gcloud auth application-default login --no-launch-browser --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/devstorage.full_control; then
      echo "ERROR: gcloud auth application-default login failed." >&2
      return 1
    fi
  else
    echo "User already logged in with Application Default Credentials."
  fi

  # If PROJECT_ID is not set from .env, try to get it from gcloud config.
  if [ -z "$PROJECT_ID" ]; then
    PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
    if [ -n "$PROJECT_ID" ]; then
      echo "Using configured gcloud project: $PROJECT_ID"
    else
      # If still no PROJECT_ID, prompt the user to select one.
      echo "Could not determine gcloud project. Fetching available projects..."
      mapfile -t projects < <(gcloud projects list --format="value(projectId,name)" --sort-by=projectId)

      if [ ${#projects[@]} -eq 0 ]; then
        echo "No projects found. Please enter your Google Cloud Project ID manually:"
        read -p "Project ID: " PROJECT_ID
        if [ -z "$PROJECT_ID" ]; then
          echo "ERROR: Project ID is required." >&2
          return 1
        fi
      else
        echo "Please select a project:"
        for i in "${!projects[@]}"; do
          printf "%3d) %s\n" "$((i+1))" "${projects[$i]}"
        done
        read -p "Enter number: " choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#projects[@]}" ]; then
          PROJECT_ID=$(echo "${projects[$((choice-1))]}" | awk '{print $1}')
        else
          echo "ERROR: Invalid selection." >&2
          return 1
        fi
      fi
    fi
  fi
fi

# --- Step 3: Finalize Project Configuration ---
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: Project ID could not be determined. Please check your configuration." >&2
  return 1
fi

# echo "Setting active gcloud project to: $PROJECT_ID"
# gcloud config set project "$PROJECT_ID"

if [ -z "$PROJECT_NUMBER" ]; then
  # Get project number, which is needed for some service agent roles
  PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
fi

# --- Virtual Environment Setup ---
if [ ! -d ".venv/python3.12" ]; then
   # --- Ensure 'unzip' is installed for VSIX validation ---
  if ! command -v unzip &> /dev/null; then
    echo "'unzip' command not found. Attempting to install..."
    sudo apt-get update && sudo apt-get install -y unzip
  fi

  # --- Ensure 'jq' is installed for robust JSON parsing ---
  if ! command -v jq &> /dev/null; then
    echo "'jq' command not found. Attempting to install..."
    sudo apt-get update && sudo apt-get install -y jq
  fi

  # --- VS Code Extension Setup (One-time) ---
  echo "Checking for 'emeraldwalk.runonsave' VS Code extension..."
  # Use the full path to the executable, which we know from the environment
  CODE_OSS_EXEC="/opt/code-oss/bin/codeoss-cloudworkstations"

  if ! $CODE_OSS_EXEC --list-extensions | grep -q "emeraldwalk.runonsave"; then
    echo "Extension not found. Installing 'emeraldwalk.runonsave'..."

    # Using the static URL as requested. Note: This points to an older version (0.3.2)
    # and replaces the logic that dynamically finds the latest version.
    VSIX_URL="https://www.vsixhub.com/go.php?post_id=519&app_id=65a449f8-c656-4725-a000-afd74758c7e6&s=v5O4xJdDsfDYE&link=https%3A%2F%2Fmarketplace.visualstudio.com%2F_apis%2Fpublic%2Fgallery%2Fpublishers%2Femeraldwalk%2Fvsextensions%2FRunOnSave%2F0.3.2%2Fvspackage"
    VSIX_FILE="/tmp/emeraldwalk.runonsave.vsix" # Use /tmp for the download

    echo "Downloading extension from specified static URL..."
    # Use curl with -L to follow redirects and -o to specify output file
    # Add --fail to error out on HTTP failure and -A to specify a browser User-Agent
    if curl --fail -L -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.103 Safari/537.36' -o "$VSIX_FILE" "$VSIX_URL"; then
      echo "Download complete. Installing..."
      # Add a check to ensure the downloaded file is a valid zip archive (.vsix)
      if unzip -t "$VSIX_FILE" &> /dev/null; then
        if $CODE_OSS_EXEC --install-extension "$VSIX_FILE"; then
          echo "Extension 'emeraldwalk.runonsave' installed successfully."
          echo "IMPORTANT: Please reload the VS Code window to activate the extension."
        else
          echo "Error: Failed to install the extension from '$VSIX_FILE'." >&2
        fi
      else
        echo "Error: Downloaded file is not a valid VSIX package. It may be an HTML page." >&2
        echo "Please check the VSIX_URL in the script or your network connection." >&2
      fi
      # Clean up the downloaded file
      rm -f "$VSIX_FILE" # This will run regardless of install success/failure
    else
      echo "Error: Failed to download the extension from '$VSIX_URL'." >&2
    fi
  else
    echo "Extension 'emeraldwalk.runonsave' is already installed."
  fi
else
  echo "Virtual environment '.python3.12' already exists."
fi

# This POSIX-compliant check ensures the script is sourced, not executed.
# (return 0 2>/dev/null) will succeed if sourced and fail if executed.
if ! (return 0 2>/dev/null); then
  echo "-------------------------------------------------------------------"
  echo "ERROR: This script must be sourced, not executed."
  echo "Usage: source .scripts/configure.sh"
  echo "-------------------------------------------------------------------"
  exit 1
fi

sudo npm install -g npm@latest
sudo npm install -g @google/clasp

export PATH=$PATH:$HOME/.local/bin:.scripts

if type deactivate &>/dev/null; then
  echo "Deactivating existing virtual environment..."
  deactivate
fi

echo "Activating environment './venv/python3.12'..."
 . .venv/python3.12/bin/activate

# Ensure dependencies are installed/updated every time the script is sourced.
# This prevents ModuleNotFoundError if requirements.txt changes after the
# virtual environment has been created.
echo "Ensuring dependencies from requirements.txt are installed..."
 # Use the full path to the venv pip to ensure we're installing in the correct environment.
./.venv/python3.12/bin/pip install -r requirements.txt > /dev/null

# --- Create or Update .env file for python-dotenv ---
# This allows local development tools to load environment variables without
# needing to source this script every time.
ENV_FILE=".env"
echo "Creating/updating ${ENV_FILE} for local development..."

# Helper function to update or add a key-value pair to the .env file
update_or_add_env() {
  local key=$1
  local value=$2
  local file=$3

  # Create the file if it doesn't exist
  touch "$file"

  # Check if the key exists (and is not commented out)
  if grep -q -E "^\s*${key}=" "$file"; then
    # If it exists, update it. The sed command looks for lines starting with the key
    # and replaces the entire line.
    # The use of a different separator for sed (e.g., |) avoids issues if the value contains slashes.
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    # If it doesn't exist, append it to the end of the file.
    echo "${key}=${value}" >> "$file"
  fi
}

# Update all the relevant variables in the .env file
update_or_add_env "PROJECT_ID" "${PROJECT_ID}" "${ENV_FILE}"
update_or_add_env "GOOGLE_APPLICATION_CREDENTIALS" "${GOOGLE_APPLICATION_CREDENTIALS}" "${ENV_FILE}"
update_or_add_env "GCS_UPLOAD_BUCKET" "${GCS_UPLOAD_BUCKET}" "${ENV_FILE}"


# This POSIX-compliant check ensures the script is sourced, not executed.
# (return 0 2>/dev/null) will succeed if sourced and fail if executed.
if ! (return 0 2>/dev/null); then
  echo "-------------------------------------------------------------------"
  echo "ERROR: This script must be sourced, not executed."
  echo "Usage: source .scripts/configure.sh"
  echo "-------------------------------------------------------------------"
  exit 1
fi
