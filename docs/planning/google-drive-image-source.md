# Google Drive Image Source

Use your own brand photos, logos, and illustrations stored in Google Drive as image sources in the editor.

## Setup

### Step 1: Organize images in Google Drive

Create a folder (e.g., `Brand Assets`) in your Google Drive and add your images. Subfolders are supported (e.g., `Brand Assets/Heroes`, `Brand Assets/Team`).

Supported formats: JPEG, PNG, WebP, GIF. Images are automatically optimized (resized and compressed to WebP) when served.

### Step 2: Share the folder

**Option A: Service Account (recommended for production)**

1. Your admin provides a service account email (e.g., `site-editor@project.iam.gserviceaccount.com`)
2. Right-click your folder in Google Drive, select **Share**, and add the service account email as **Viewer**
3. Copy the folder ID from the URL: `https://drive.google.com/drive/folders/`**`<FOLDER_ID>`**

**Option B: API Key with public folder (simpler for dev/demo)**

1. Right-click your folder, select **Share**, then set General access to **Anyone with the link** (Viewer)
2. Copy the folder ID from the URL

### Step 3: Configure environment

Add the following to your `.env` file:

```bash
GOOGLE_DRIVE_FOLDER_ID=1aBcDeFgHiJkLmNoPqRsTuVwXyZ

# Option A: Service account (production)
GOOGLE_SERVICE_ACCOUNT_KEY_JSON={"type":"service_account","client_email":"...","private_key":"..."}

# Option B: API key (dev/demo)
GOOGLE_API_KEY=AIza...
```

Only one auth method is needed. If both are set, the service account takes precedence.

### Step 4: Restart the dev server

```bash
pnpm dev
```

The Google Drive integration activates automatically when `GOOGLE_DRIVE_FOLDER_ID` is set along with valid credentials.

## How it works

### AI chat

The AI planner can search and select images from your Drive folder. Use natural language:

- "Use a hero image from our Drive folder"
- "Add a brand photo for the about section"
- "Use our company images for the team cards"

The AI recognizes phrases like "brand", "our photos", "company images", "from Drive", and "brand assets" as signals to search your Google Drive folder.

### Image picker

When Google Drive is configured, clicking an image field in the preview opens the Image Picker modal. The **Drive** tab lets you browse and search images from your shared folder.

1. Click any image in the preview
2. The Image Picker opens with the Drive tab active
3. Use the search box to filter images by name
4. Click a thumbnail to select it
5. Click **Select Image** to apply

### Fallback cascade

When the AI needs an image and no specific source is requested, it tries sources in this order:

1. **AI Generation** (if OpenAI API key is configured)
2. **Google Drive** (if configured)
3. **Unsplash** (if access key is configured)

### Image optimization

All Google Drive images are automatically optimized on first access:

- Resized to fit within 1536x1024 pixels (preserving aspect ratio)
- Converted to WebP format at quality 80
- EXIF data stripped, auto-oriented
- Cached on disk for instant subsequent loads

## Troubleshooting

**Drive tab doesn't appear in the Image Picker**
- Verify `GOOGLE_DRIVE_FOLDER_ID` is set in `.env`
- Verify either `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` or `GOOGLE_API_KEY` is set
- Restart the dev server after changing env vars

**No images found**
- Verify the folder contains image files (not just subfolders)
- If using a service account, verify it has Viewer access to the folder
- If using an API key, verify the folder's sharing is set to "Anyone with the link"

**Images load slowly on first view**
- The first request for each image downloads it from Google Drive and optimizes it. Subsequent requests are served from the local cache and load instantly.

## API endpoints

For advanced integrations, the orchestrator exposes these endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /gdrive/images?q=&limit=` | List images from the shared folder |
| `GET /gdrive/images/:fileId` | Download and serve an optimized image |
| `GET /status/planner` | Includes `features.googleDrive` flag |
