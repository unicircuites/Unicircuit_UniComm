require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('../db/pool');
const { getAccessToken, getClientCredentialsToken } = require('../services/msGraph');
const oneDriveSync = require('../services/oneDriveSync');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const fetch = require('node-fetch');

const LOCAL_STORE = process.env.PBX_LOCAL_RECORDINGS_DIR || 'D:\\Unicomm_Storage';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Cache for folder IDs to avoid querying Graph API repeatedly for the same folder
const folderIdCache = new Map(); // path string -> folder item ID

async function getBestToken() {
  const delegated = await getAccessToken(process.env.MS_USER_EMAIL).catch(() => null);
  if (delegated) return delegated;
  const cc = await getClientCredentialsToken().catch(() => null);
  if (cc) return cc;
  throw new Error('No valid Microsoft Graph token available.');
}

// Replicate sharing link conversion
function encodeSharingUrl(url) {
  return `u!${Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')}`;
}

// ── Recursive scanner ──────────
async function collectAllFiles(dir, baseDir, results = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err.message);
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAllFiles(fullPath, baseDir, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.wav', '.mp3', '.ogg', '.m4a'].includes(ext)) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push({ fullPath, relativePath, filename: entry.name });
      }
    }
  }
  return results;
}

// ── Resolve folder path on OneDrive sequentially ──────────
async function resolveOneDrivePath(token, driveId, rootFolderId, relativeFolderPath) {
  if (!relativeFolderPath || relativeFolderPath === '.') {
    return rootFolderId;
  }

  const normalizedPath = relativeFolderPath.replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  if (folderIdCache.has(normalizedPath)) {
    return folderIdCache.get(normalizedPath);
  }

  const segments = normalizedPath.split('/');
  let currentParentId = rootFolderId;
  let currentPathAccumulator = '';

  for (const segment of segments) {
    if (!segment) continue;
    currentPathAccumulator = currentPathAccumulator ? `${currentPathAccumulator}/${segment}` : segment;

    if (folderIdCache.has(currentPathAccumulator)) {
      currentParentId = folderIdCache.get(currentPathAccumulator);
      continue;
    }

    // Check if folder exists
    const encodedSegment = encodeURIComponent(segment);
    const checkUrl = `${GRAPH}/drives/${driveId}/items/${currentParentId}/children?$filter=name eq '${encodedSegment}'`;
    
    const checkRes = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    let folderId = null;
    if (checkRes.ok) {
      const data = await checkRes.json();
      const match = (data.value || []).find(item => item.name === segment && item.folder);
      if (match) {
        folderId = match.id;
      }
    }

    if (!folderId) {
      // Create folder
      console.log(`[Migration] Creating OneDrive folder: "${segment}" under parent item ID: ${currentParentId}`);
      const createUrl = `${GRAPH}/drives/${driveId}/items/${currentParentId}/children`;
      const createRes = await fetch(createUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: segment,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail'
        })
      });

      if (!createRes.ok) {
        // Handle race conditions where folder was created simultaneously
        if (createRes.status === 409) {
          const fetchRetryRes = await fetch(checkUrl, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (fetchRetryRes.ok) {
            const retryData = await fetchRetryRes.json();
            const retryMatch = (retryData.value || []).find(item => item.name === segment && item.folder);
            if (retryMatch) folderId = retryMatch.id;
          }
        }
        
        if (!folderId) {
          const err = await createRes.json().catch(() => ({}));
          throw new Error(`Failed to create folder "${segment}": ${err.error?.message || createRes.status}`);
        }
      } else {
        const created = await createRes.json();
        folderId = created.id;
      }
    }

    folderIdCache.set(currentPathAccumulator, folderId);
    currentParentId = folderId;
  }

  return currentParentId;
}

// ── Upload function using Microsoft Graph API ──────────
async function uploadFileToFolder(token, driveId, folderId, localFilePath, remoteFileName) {
  const encodedName = encodeURIComponent(remoteFileName);
  const uploadUrl = `${GRAPH}/drives/${driveId}/items/${folderId}:/${encodedName}:/content`;

  const stat = await fs.promises.stat(localFilePath);
  const sizeMB = stat.size / (1024 * 1024);

  if (sizeMB <= 4) {
    const buffer = await fs.promises.readFile(localFilePath);
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
    `${GRAPH}/drives/${driveId}/items/${folderId}:/${encodedName}:/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: remoteFileName } }),
    }
  );
  if (!sessionRes.ok) throw new Error(`Could not create upload session for ${remoteFileName}`);
  const { uploadUrl: sessionUrl } = await sessionRes.json();

  const CHUNK = 4 * 1024 * 1024;
  const fileBuffer = await fs.promises.readFile(localFilePath);
  let offset = 0;

  while (offset < stat.size) {
    const chunk = fileBuffer.slice(offset, offset + CHUNK);
    const end = Math.min(offset + CHUNK - 1, stat.size - 1);
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

  return { name: remoteFileName };
}

// ── Migration Process ──────────
async function runMigration() {
  console.log('========================================================');
  console.log('   PBX Call Recordings OneDrive Folder-wise Migration');
  console.log('========================================================');
  console.log(`Source Directory (Local D: Drive): ${LOCAL_STORE}`);

  if (!fs.existsSync(LOCAL_STORE)) {
    console.error(`❌ Source directory ${LOCAL_STORE} does not exist. No recordings to migrate.`);
    return;
  }

  let token;
  try {
    token = await getBestToken();
    console.log('✅ MS Graph token acquired successfully.');
  } catch (err) {
    console.error('❌ Failed to retrieve MS Graph token:', err.message);
    return;
  }

  let targetFolder;
  try {
    // Dynamically resolve OneDrive Call_Recordings target
    const getTargetFolderFn = oneDriveSync.getTargetFolder || oneDriveSync.__proto__.getTargetFolder;
    targetFolder = await oneDriveSync.getTargetFolder(token);
    console.log(`✅ OneDrive target folder resolved: ${targetFolder.label}`);
  } catch (err) {
    console.error('❌ Failed to resolve target folder:', err.message);
    return;
  }

  // Load the sync log to keep record of uploaded files
  const logFile = path.join(__dirname, '..', 'data', 'onedrive_sync_log.json');
  let syncLog = { uploadedFiles: [], lastSync: null };
  try {
    const raw = await fsp.readFile(logFile, 'utf8');
    syncLog = JSON.parse(raw);
    if (!Array.isArray(syncLog.uploadedFiles)) syncLog.uploadedFiles = [];
  } catch (_) {
    // Use default
  }
  const uploadedFilesSet = new Set(syncLog.uploadedFiles);

  console.log('\n[Scan] Scanning local files in D:\\Unicomm_Storage...');
  const files = await collectAllFiles(LOCAL_STORE, LOCAL_STORE);
  console.log(`[Scan] Found ${files.length} recording file(s) in local store.`);

  if (files.length === 0) {
    console.log('✅ Migration complete. No files to copy.');
    return;
  }

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const percentage = (((i + 1) / files.length) * 100).toFixed(1);
    
    // Check if the filename is already marked in our sync log
    if (uploadedFilesSet.has(file.filename)) {
      console.log(`[${percentage}%] Skip (already registered in sync log): ${file.relativePath}`);
      skippedCount++;
      continue;
    }

    try {
      // Find subfolder path (e.g. "27Jun_2026_102301/202" from "27Jun_2026_102301/202/EXT390.wav")
      const relativeFolder = path.dirname(file.relativePath);
      
      // Resolve/Create subfolder in OneDrive under Call_Recordings folder
      const folderId = await resolveOneDrivePath(token, targetFolder.driveId, targetFolder.itemId, relativeFolder);

      // Upload file to this specific folder
      console.log(`[${percentage}%] Uploading: ${file.relativePath} to OneDrive folder...`);
      await uploadFileToFolder(token, targetFolder.driveId, folderId, file.fullPath, file.filename);

      // Add to sync log
      uploadedFilesSet.add(file.filename);
      successCount++;
      console.log(`[${percentage}%] ✅ Uploaded successfully: ${file.filename}`);

      // Save log periodically (every 5 files) to prevent data loss in case of interruption
      if (successCount % 5 === 0) {
        syncLog.uploadedFiles = [...uploadedFilesSet];
        await fsp.mkdir(path.dirname(logFile), { recursive: true });
        await fsp.writeFile(logFile, JSON.stringify(syncLog, null, 2), 'utf8');
      }
    } catch (err) {
      console.error(`[${percentage}%] ❌ Failed to upload ${file.relativePath}:`, err.message);
      failedCount++;
    }
  }

  // Final sync log write
  syncLog.uploadedFiles = [...uploadedFilesSet];
  syncLog.lastSync = new Date().toISOString();
  await fsp.mkdir(path.dirname(logFile), { recursive: true });
  await fsp.writeFile(logFile, JSON.stringify(syncLog, null, 2), 'utf8');

  console.log('\n========================================================');
  console.log('               Migration Summary');
  console.log('========================================================');
  console.log(`  Total Scanned : ${files.length}`);
  console.log(`  Uploaded      : ${successCount}`);
  console.log(`  Skipped       : ${skippedCount}`);
  console.log(`  Failed        : ${failedCount}`);
  console.log('========================================================');
  console.log('Before deleting files from the D drive, please verify they are visible on OneDrive.');
}

runMigration()
  .catch(err => {
    console.error('Migration crashed:', err);
  })
  .finally(() => {
    pool.end().catch(() => {});
  });
