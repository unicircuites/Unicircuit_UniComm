/**
 * Standalone OneDrive Folder-wise Migration Test Script (Database-free)
 * ─────────────────────────────────────────────────────────────────────────────
 * This script runs independently of the database. It authenticates using the 
 * credentials in `.env`, scans the configured local folder, resolves your OneDrive 
 * sharing link, and uploads files preserving the folder structure.
 */

// Load environment variables from backend/.env
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ── CONFIGURATION (Edit these or let them read from .env) ────────────────────
const CONFIG = {
  // Microsoft App Credentials
  clientId:     process.env.MS_CLIENT_ID,
  tenantId:     process.env.MS_TENANT_ID,
  clientSecret: process.env.MS_CLIENT_SECRET,
  userEmail:    process.env.MS_USER_EMAIL || 'sales@unicircuites.com',

  // OneDrive Target Sharing Link
  oneDriveLink: process.env.ONEDRIVE_FOLDER_LINK || 'https://unicircuites-my.sharepoint.com/:f:/r/personal/sales_unicircuites_com/Documents/Call_Recordings?csf=1&web=1&e=e9ep1N',

  // Local Folder containing recordings to test with
  localSourceDir: 'D:\\Unicomm_Storage' // Change to a local folder with some files to test
};

const GRAPH = 'https://graph.microsoft.com/v1.0';
const folderIdCache = new Map(); // path string -> folder item ID

// ── Helper: Get App Access Token ─────────────────────────────────────────────
async function getAppToken() {
  const msalConfig = {
    auth: {
      clientId: CONFIG.clientId,
      authority: `https://login.microsoftonline.com/${CONFIG.tenantId || 'common'}`,
      clientSecret: CONFIG.clientSecret,
    }
  };
  const cca = new msal.ConfidentialClientApplication(msalConfig);
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default']
  });
  return result.accessToken;
}

// ── Helper: Base64 encode sharing link ────────────────────────────────────────
function encodeSharingUrl(url) {
  return `u!${Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')}`;
}

// ── Helper: Scan Directory Recursively ──────────────────────────────────────
async function scanLocalFiles(dir, baseDir, results = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanLocalFiles(fullPath, baseDir, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.wav', '.mp3', '.ogg', '.m4a', '.txt'].includes(ext)) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push({ fullPath, relativePath, filename: entry.name });
      }
    }
  }
  return results;
}

// ── Helper: Resolve/Create Subfolder Path in OneDrive ────────────────────────
async function getOrCreateOneDriveFolder(token, driveId, rootFolderId, relativeFolderPath) {
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

    const encodedSegment = encodeURIComponent(segment);
    const checkUrl = `${GRAPH}/drives/${driveId}/items/${currentParentId}/children?$filter=name eq '${encodedSegment}'`;
    const checkRes = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    let folderId = null;
    if (checkRes.ok) {
      const data = await checkRes.json();
      const match = (data.value || []).find(item => item.name === segment && item.folder);
      if (match) folderId = match.id;
    }

    if (!folderId) {
      console.log(`[OneDrive] Creating folder: "${segment}" under item ID: ${currentParentId}`);
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
        if (createRes.status === 409) {
          const retryRes = await fetch(checkUrl, { headers: { Authorization: `Bearer ${token}` } });
          if (retryRes.ok) {
            const data = await retryRes.json();
            const match = (data.value || []).find(item => item.name === segment && item.folder);
            if (match) folderId = match.id;
          }
        }
        if (!folderId) {
          const err = await createRes.json().catch(() => ({}));
          throw new Error(`Folder creation failed: ${err.error?.message || createRes.status}`);
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

// ── Helper: Upload File to OneDrive ──────────────────────────────────────────
async function uploadFileToFolder(token, driveId, folderId, localFilePath, remoteFileName) {
  const encodedName = encodeURIComponent(remoteFileName);
  const uploadUrl = `${GRAPH}/drives/${driveId}/items/${folderId}:/${encodedName}:/content`;
  const stat = await fsp.stat(localFilePath);
  const sizeMB = stat.size / (1024 * 1024);

  if (sizeMB <= 4) {
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

  // Large upload session (>4MB)
  const sessionRes = await fetch(
    `${GRAPH}/drives/${driveId}/items/${folderId}:/${encodedName}:/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename', name: remoteFileName } }),
    }
  );
  if (!sessionRes.ok) throw new Error('Could not initialize large file upload session.');
  const { uploadUrl: sessionUrl } = await sessionRes.json();

  const CHUNK = 4 * 1024 * 1024;
  const fileBuffer = await fsp.readFile(localFilePath);
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
}

// ── Main Test Process ────────────────────────────────────────────────────────
async function main() {
  console.log('========================================================');
  console.log('    OneDrive Folder-wise Standalone Migration Test      ');
  console.log('========================================================');
  console.log('Local folder to scan:', CONFIG.localSourceDir);
  console.log('OneDrive link:', CONFIG.oneDriveLink);

  try {
    // 1. Authenticate
    console.log('\n[1/4] Authenticating with Microsoft Graph...');
    const token = await getAppToken();
    console.log('✅ Access Token acquired successfully.');

    // 2. Resolve OneDrive target folder link
    console.log('\n[2/4] Resolving sharing URL...');
    const shareId = encodeSharingUrl(CONFIG.oneDriveLink);
    const shareRes = await fetch(`${GRAPH}/shares/${shareId}/driveItem`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!shareRes.ok) {
      const err = await shareRes.json().catch(() => ({}));
      throw new Error(`Sharing link resolution failed: ${err.error?.message || shareRes.status}`);
    }

    const targetFolder = await shareRes.json();
    console.log('✅ Target folder resolved successfully:');
    console.log('   Drive ID:', targetFolder.parentReference?.driveId);
    console.log('   Folder Name:', targetFolder.name);
    console.log('   Folder Item ID:', targetFolder.id);

    const driveId = targetFolder.parentReference?.driveId;
    const rootFolderId = targetFolder.id;

    // 3. Scan local files
    console.log('\n[3/4] Scanning local folder...');
    if (!fs.existsSync(CONFIG.localSourceDir)) {
      console.log(`⚠️ Local folder ${CONFIG.localSourceDir} does not exist. Creating it and writing a dummy test file...`);
      await fsp.mkdir(path.join(CONFIG.localSourceDir, 'Test_Folder_1', 'Sub_Folder_A'), { recursive: true });
      const testFile = path.join(CONFIG.localSourceDir, 'Test_Folder_1', 'Sub_Folder_A', 'EXT390_TEST_MIGRATION.txt');
      await fsp.writeFile(testFile, 'UniComm Standalone Migration Test File Content\n');
      console.log(`✅ Created dummy test file at: ${testFile}`);
    }

    const files = await scanLocalFiles(CONFIG.localSourceDir, CONFIG.localSourceDir);
    console.log(`✅ Found ${files.length} file(s) ready for migration.`);

    // 4. Begin Uploads
    console.log('\n[4/4] Starting folder-wise upload...');
    let successCount = 0;
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const percent = (((i + 1) / files.length) * 100).toFixed(0);
      try {
        const relativeFolder = path.dirname(file.relativePath);
        
        // Resolve/create nested folder structure on OneDrive
        const folderId = await getOrCreateOneDriveFolder(token, driveId, rootFolderId, relativeFolder);
        
        console.log(`[${percent}%] Uploading "${file.relativePath}"...`);
        await uploadFileToFolder(token, driveId, folderId, file.fullPath, file.filename);
        console.log(`[${percent}%] ✅ Upload completed.`);
        successCount++;
      } catch (err) {
        console.error(`[${percent}%] ❌ Upload failed for "${file.relativePath}":`, err.message);
      }
    }

    console.log('\n========================================================');
    console.log('                 Test Run Summary');
    console.log('========================================================');
    console.log(`  Scanned Files : ${files.length}`);
    console.log(`  Uploaded      : ${successCount}`);
    console.log(`  Failed        : ${files.length - successCount}`);
    console.log('========================================================');

  } catch (err) {
    console.error('\n❌ Diagnostic Test Failed:', err.message);
  }
}

main();
