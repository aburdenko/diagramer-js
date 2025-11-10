# Diagramer-JS

This project integrates Google Apps Script with a local development environment using `clasp`.

## Setup Instructions

Follow these steps to set up and run the project:

### 1. Install Prerequisites

Make sure you have Node.js and npm installed. Then, install Google Clasp globally:

```bash
npm install -g @google/clasp
```

### 2. Authenticate with Google Clasp

Log in to your Google account using Clasp. This will open a browser window for authentication.

```bash
clasp login
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory of your project. This file will store sensitive information and configuration variables.

Example `.env` content:

```
# Replace with your actual Google Apps Script ID
APPS_SCRIPT_ID=YOUR_APPS_SCRIPT_ID
```

**How to get `YOUR_APPS_SCRIPT_ID`:**
1. Open your Google Apps Script project (e.g., from Google Drive or script.google.com).
2. Go to `Project Settings` (the gear icon on the left sidebar).
3. Copy the `Script ID`.

### 4. Link to Google Apps Script Project

If you haven't already, link your local project to your Google Apps Script project using the `scriptId` from your `.env` file.

```bash
clasp clone <YOUR_APPS_SCRIPT_ID>
```
*Note: If you cloned the project, the `.clasp.json` file should already contain the `scriptId`.*

### 5. Push Changes and Watch for Updates

To continuously push your local changes to the Google Apps Script project, use the `clasp push --watch --force` command. This command will:
- `push`: Upload your local files to the Apps Script project.
- `--watch`: Monitor your local files for changes and automatically push them.
- `--force`: Overwrite remote files without confirmation.

You can run this command directly in your terminal:

```bash
clasp push --watch --force
```

**Using with VS Code Tasks:**
If you have this command configured as a VS Code task, you can run it directly from VS Code's integrated terminal or through the "Run Task" command palette option. This is useful for automating the deployment process during development.

### 6. Open the Apps Script Project

You can open your Apps Script project in the browser using:

```bash
clasp open
```