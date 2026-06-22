/**
 * OneDrive Recordings Sync Service — UniComm Pro
 * ─────────────────────────────────────────────────────────────────────────
 * UPLOAD  : Daily at 6:30 PM IST — scans PBX_RECORDINGS_DIR for new/unique
 *           recordings and uploads them to OneDrive (UniComm_Recordings folder)
 *           under sales@unicircuites.com's personal drive.
 *
 * DOWNLOAD: On-demand — when a recording is requested and not found locally,
 *           fetches it from OneDrive into PBX_LOCAL_RECORDINGS_DIR (cache).
 *
 * CLEANUP : Daily at 6:30 PM IST (before upload) — removes files from the
 *           local cache older than ONEDRIVE_CACHE_DAYS (default 30 days).
 *
 * TRACKING: Uses a JSON log file (data/onedrive_sync_log.json) to remember
 *           which files have already been uploaded — prevents re-uploads.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs      = require('fs');
const fsp     = fs.promises;
const path    = require('path');
const fetch   = require('node-fetch');
const { getAccessToken, getClientCredentialsToken } = require('./msGraph');

// ── Config ─────────────────────────────────────────────────────────────────
const PBX_SOURCE_DIR  = process.env.PBX_RECORDINGS_DIR       || '\\\\UNISERVER\\MatrixVMS';
const LOCAL_CACHE_DIR = process.env.PBX_LOCAL_RECORDINGS_DIR || 'D:\\Unicomm_Storage';
const CACHE_DAYS      = parseInt(process.env.ONEDRIVE_CACHE_DAYS || '30', 10);
const OD_FOLDER       = process.env.ONEDRIVE_FOLDER           || 'UniComm_Recordings';
const OD_FOLDER_LINK  = process.env.ONEDRIVE_FOLDER_LINK      || '';
const USER_EMAIL      = process.env.MS_USER_EMAIL             || 'sales@unicircuites.com';
const GRAPH           = 'https://graph.microsoft.com/v1.0';
const LOG_FILE        = path.join(__dirname, '..', 'data', 'onedrive_sync_log.json');
const GRAPH_VERBOSE   = process.env.MS_GRAPH_VERBOSE === '1';

// ── Sync log (tracks uploaded filenames to avoid re-uploads) ───────────────
let _syncLog = null; // { uploadedFiles: Set<string>, lastSync: string }

async function loadSyncLog() {
  if (_syncLog) return _syncLog;
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    _syncLog = {
      uploadedFiles: new Set(parsed.uploadedFiles || []),
      lastSync: parsed.lastSync || null,
    };
  } catch {
    _syncLog = { uploadedFiles: new Set(), lastSync: null };
  }
  return _syncLog;
}

async function saveSyncLog() {
  if (!_syncLog) return;
  await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fsp.writeFile(LOG_FILE, JSON.stringify({
    uploadedFiles: [..._syncLog.uploadedFiles],
    lastSync: _syncLog.lastSync,
  }, null, 2), 'utf8');
}

// ── Token helper ───────────────────────────────────────────────────────────
async function getBestToken() {
  // Try delegated token first, fall back to client credentials
  const delegated = await getAccessToken(USER_EMAIL).catch(() => null);
  if (delegated) return delegated;
  const cc = await getClientCredentialsToken().catch(() => null);
  if (cc) return cc;
  throw new Error('No valid Microsoft Graph token available. Please connect Outlook first.');
}

function encodeSharingUrl(url) {
  return `u!${Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')}`;
}

// ── Ensure OneDrive folder exists ──────────────────────────────────────────
async function ensureOneDriveFolder(token) {
  const encodedUser = encodeURIComponent(USER_EMAIL);
  const url = `${GRAPH}/users/${encodedUser}/drive/root:/${OD_FOLDER}`;

  const checkRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (checkRes.ok) {
    const data = await checkRes.json();
    if (GRAPH_VERBOSE) console.log(`[OneDrive] Folder "${OD_FOLDER}" exists (id: ${data.id})`);
    return data.id;
  }

  // Folder doesn't exist — create it
  console.log(`[OneDrive] Creating folder "${OD_FOLDER}" in OneDrive...`);
  const createRes = await fetch(`${GRAPH}/users/${encodedUser}/drive/root/children`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: OD_FOLDER, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(`Failed to create OneDrive folder: ${err.error?.message || createRes.status}`);
  }

  const created = await createRes.json();
  console.log(`[OneDrive] ✅ Folder "${OD_FOLDER}" created.`);
  return created.id;
}

async function getTargetFolder(token) {
  if (OD_FOLDER_LINK) {
    const shareId = encodeSharingUrl(OD_FOLDER_LINK);
    const res = await fetch(`${GRAPH}/shares/${shareId}/driveItem`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Failed to resolve OneDrive folder link: ${err.error?.message || res.status}`);
    }

    const item = await res.json();
    return {
      driveId: item.parentReference?.driveId,
      itemId: item.id,
      label: item.webUrl || OD_FOLDER_LINK,
    };
  }

  const encodedUser = encodeURIComponent(USER_EMAIL);
  const itemId = await ensureOneDriveFolder(token);
  const driveRes = await fetch(`${GRAPH}/users/${encodedUser}/drive`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!driveRes.ok) {
    throw new Error(`Failed to resolve OneDrive drive: HTTP ${driveRes.status}`);
  }

  const drive = await driveRes.json();
  return { driveId: drive.id, itemId, label: OD_FOLDER };
}

// ── Upload a single file to OneDrive ──────────────────────────────────────
// Uses Graph simple upload for files < 4 MB, large-file upload session for bigger files
async function uploadFile(token, targetFolder, localFilePath, remoteFileName) {
  const encodedName = encodeURIComponent(remoteFileName);
  const uploadUrl   = `${GRAPH}/drives/${targetFolder.driveId}/items/${targetFolder.itemId}:/${encodedName}:/content`;

  const stat    = await fsp.stat(localFilePath);
  const sizeMB  = stat.size / (1024 * 1024);

  if (sizeMB <= 4) {
    // Simple upload
    const buffer = await fsp.readFile(localFilePath);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
      },
      body: buffer,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Upload failed: HTTP ${res.status}`);
    }
    return await res.json();
  }

  // Large file upload session
  const sessionRes = await fetch(
    `${GRAPH}/drives/${targetFolder.driveId}/items/${targetFolder.itemId}:/${encodedName}:/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: remoteFileName } }),
    }
  );
  if (!sessionRes.ok) throw new Error(`Could not create upload session for ${remoteFileName}`);
  const { uploadUrl: sessionUrl } = await sessionRes.json();

  // Upload in 4 MB chunks
  const CHUNK = 4 * 1024 * 1024;
  const fileBuffer = await fsp.readFile(localFilePath);
  let offset = 0;

  while (offset < stat.size) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK);
    const end   = Math.min(offset + CHUNK - 1, stat.size - 1);
    const chunkRes = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': chunk.length,
        'Content-Range': `bytes ${offset}-${end}/${stat.size}`,
      },
      body: chunk,
    });
    if (!chunkRes.ok && chunkRes.status !== 202) {
      throw new Error(`Chunk upload failed at byte ${offset}: HTTP ${chunkRes.status}`);
    }
    offset += chunk.length;
  }

  console.log(`[OneDrive] ✅ Large file uploaded: ${remoteFileName} (${sizeMB.toFixed(1)} MB)`);
  return { name: remoteFileName };
}

// ── Recursively collect all audio/recording files from source dir ──────────
async function collectRecordingFiles(dir, results = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return results; // dir doesn't exist yet — skip silently
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRecordingFiles(fullPath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // Accept common audio formats the PBX may produce
      if (['.wav', '.mp3', '.ogg', '.amr', '.aac', '.opus', '.gsm', '.g711', '.g729'].includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// ── Main upload job ────────────────────────────────────────────────────────
async function runUploadJob() {
  console.log('[OneDrive] ⬆️  Starting daily recording upload job...');
  const log = await loadSyncLog();

  let token;
  try {
    token = await getBestToken();
  } catch (err) {
    console.error('[OneDrive] ❌ Cannot get Graph token:', err.message);
    return { uploaded: 0, skipped: 0, failed: 0, error: err.message };
  }

  let targetFolder;
  try {
    targetFolder = await getTargetFolder(token);
    console.log(`[OneDrive] Target folder resolved: ${targetFolder.label}`);
  } catch (err) {
    console.error('[OneDrive] ❌ Folder setup failed:', err.message);
    return { uploaded: 0, skipped: 0, failed: 0, error: err.message };
  }

  // Collect all recording files from PBX source
  const files = await collectRecordingFiles(PBX_SOURCE_DIR);
  console.log(`[OneDrive] Found ${files.length} recording file(s) in source dir.`);

  let uploaded = 0, skipped = 0, failed = 0;

  for (const filePath of files) {
    const filename = path.basename(filePath);

    // Skip already uploaded (unique records only)
    if (log.uploadedFiles.has(filename)) {
      skipped++;
      if (GRAPH_VERBOSE) console.log(`[OneDrive] Skip (already uploaded): ${filename}`);
      continue;
    }

    try {
      await uploadFile(token, targetFolder, filePath, filename);
      log.uploadedFiles.add(filename);
      uploaded++;
      console.log(`[OneDrive] ✅ Uploaded: ${filename}`);
    } catch (err) {
      failed++;
      console.error(`[OneDrive] ❌ Failed to upload ${filename}:`, err.message);
    }
  }

  log.lastSync = new Date().toISOString();
  await saveSyncLog();

  console.log(`[OneDrive] Upload job done — uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}`);
  return { uploaded, skipped, failed };
}

// ── Local cache cleanup (delete files older than CACHE_DAYS) ──────────────
async function cleanLocalCache() {
  console.log(`[OneDrive] 🧹 Cleaning local cache (>${CACHE_DAYS} days old) in ${LOCAL_CACHE_DIR}`);
  let deleted = 0;
  const cutoff = Date.now() - CACHE_DAYS * 24 * 60 * 60 * 1000;

  async function cleanDir(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await cleanDir(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(fullPath);
          if (stat.mtimeMs < cutoff) {
            await fsp.unlink(fullPath);
            deleted++;
            if (GRAPH_VERBOSE) console.log(`[OneDrive] Deleted cached file: ${entry.name}`);
          }
        } catch { /* ignore */ }
      }
    }
  }

  await cleanDir(LOCAL_CACHE_DIR);
  console.log(`[OneDrive] 🧹 Cache cleanup done — deleted ${deleted} file(s).`);
  return deleted;
}

// ── On-demand download from OneDrive to local cache ───────────────────────
/**
 * Ensures a recording file is available locally.
 * 1. If found in LOCAL_CACHE_DIR — returns local path immediately.
 * 2. If not found — downloads from OneDrive, saves to LOCAL_CACHE_DIR, returns path.
 * 3. If not in OneDrive either — returns null.
 *
 * @param {string} filename  e.g. "EXT390_20260622_145056.wav"
 * @returns {Promise<string|null>}  absolute local path, or null if not found anywhere
 */
async function ensureLocalRecording(filename) {
  const localPath = path.join(LOCAL_CACHE_DIR, filename);

  // 1. Already in local cache?
  try {
    await fsp.access(localPath);
    console.log(`[OneDrive] Cache hit: ${filename}`);
    return localPath;
  } catch { /* not cached — fall through */ }

  // 2. Download from OneDrive
  console.log(`[OneDrive] Cache miss — downloading from OneDrive: ${filename}`);
  let token;
  try {
    token = await getBestToken();
  } catch (err) {
    console.error('[OneDrive] Cannot get token for download:', err.message);
    return null;
  }

  let targetFolder;
  try {
    targetFolder = await getTargetFolder(token);
  } catch (err) {
    console.error('[OneDrive] Cannot resolve folder for download:', err.message);
    return null;
  }

  const encodedName = encodeURIComponent(filename);
  const downloadUrl = `${GRAPH}/drives/${targetFolder.driveId}/items/${targetFolder.itemId}:/${encodedName}:/content`;

  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });

  if (!res.ok) {
    if (res.status === 404) {
      console.warn(`[OneDrive] File not found in OneDrive: ${filename}`);
    } else {
      console.error(`[OneDrive] Download failed for ${filename}: HTTP ${res.status}`);
    }
    return null;
  }

  // Save to local cache
  await fsp.mkdir(LOCAL_CACHE_DIR, { recursive: true });
  const dest = fs.createWriteStream(localPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(dest);
    res.body.on('error', reject);
    dest.on('finish', resolve);
  });

  console.log(`[OneDrive] ✅ Downloaded to cache: ${filename}`);
  return localPath;
}

// ── List all files in OneDrive folder ────────────────────────────────────
async function listOneDriveRecordings() {
  let token;
  try {
    token = await getBestToken();
  } catch (err) {
    throw new Error('Cannot get Graph token: ' + err.message);
  }

  const targetFolder = await getTargetFolder(token);
  const url = `${GRAPH}/drives/${targetFolder.driveId}/items/${targetFolder.itemId}/children?$select=name,size,lastModifiedDateTime&$top=1000`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 404) return []; // folder doesn't exist yet
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Graph API error ${res.status}`);
  }

  const data = await res.json();
  return (data.value || []).map(f => ({
    name: f.name,
    size: f.size,
    lastModified: f.lastModifiedDateTime,
    inLocalCache: fs.existsSync(path.join(LOCAL_CACHE_DIR, f.name)),
  }));
}

// ── Get sync status ───────────────────────────────────────────────────────
async function getSyncStatus() {
  const log = await loadSyncLog();
  return {
    uploadedCount: log.uploadedFiles.size,
    lastSync: log.lastSync,
    sourceDir: PBX_SOURCE_DIR,
    cacheDir: LOCAL_CACHE_DIR,
    cacheDays: CACHE_DAYS,
    oneDriveFolder: OD_FOLDER,
    oneDriveFolderLinkConfigured: !!OD_FOLDER_LINK,
    userEmail: USER_EMAIL,
  };
}

// ── Start cron scheduler ──────────────────────────────────────────────────
function start() {
  // Ensure local cache dir exists on startup
  fs.mkdirSync(LOCAL_CACHE_DIR, { recursive: true });
  cleanLocalCache().catch(err => console.error('[OneDrive] Startup cache cleanup failed:', err.message));
  console.log('[OneDrive] Manual upload service ready. Cache cleanup retention:', CACHE_DAYS, 'days');
}

module.exports = {
  start,
  runUploadJob,
  cleanLocalCache,
  ensureLocalRecording,
  listOneDriveRecordings,
  getSyncStatus,
};
