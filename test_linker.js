/**
 * Test script to diagnose recording linking against live data.
 * Run: node test_linker.js
 */
require('dotenv').config({ path: require('path').join(__dirname, 'backend/.env') });
const path = require('path');
const fs = require('fs');
const { linkRecordingsToCallLogs, parseRecordingFilename, normalizePhone } = require('./backend/services/recordingLinker');

const REC_DIR = process.env.PBX_RECORDINGS_DIR || 'C:\\MatrixVMS\\Voicemail_Backup';

console.log('\n==============================');
console.log('RECORDING LINKER DIAGNOSTICS');
console.log('==============================\n');
console.log('REC_DIR:', REC_DIR);
console.log('Dir exists:', fs.existsSync(REC_DIR));

if (!fs.existsSync(REC_DIR)) {
  console.error('\n❌ Directory not found! Check PBX_RECORDINGS_DIR in .env');
  process.exit(1);
}

// Recursive scan
function getAllFiles(dir, depth = 0) {
  let results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory() && depth < 5) {
      results = results.concat(getAllFiles(full, depth + 1));
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (['.wav', '.mp3', '.ogg', '.m4a'].includes(ext)) results.push(full);
    }
  }
  return results;
}

const files = getAllFiles(REC_DIR);
console.log(`\nTotal audio files found: ${files.length}`);

// Show first 10 sample filenames
console.log('\nSample filenames:');
files.slice(0, 10).forEach(f => console.log(' ', path.basename(f)));

// Parse them
const parsed = files.map(f => ({ file: path.basename(f), parsed: parseRecordingFilename(f) }));
const parsedOk = parsed.filter(p => p.parsed !== null);
const parsedFail = parsed.filter(p => p.parsed === null);

console.log(`\nParsed OK: ${parsedOk.length}  |  Failed to parse: ${parsedFail.length}`);
if (parsedFail.length > 0) {
  console.log('\nFiles that did NOT match the expected filename format:');
  parsedFail.slice(0, 10).forEach(p => console.log(' ', p.file));
}

if (parsedOk.length > 0) {
  console.log('\nSample parsed recordings:');
  parsedOk.slice(0, 5).forEach(p => {
    console.log(`  File: ${p.file}`);
    console.log(`    → date: ${p.parsed.timestamp.toISOString()}, ext: ${p.parsed.extension}, phone: ${p.parsed.phone}`);
  });
}

// Now run the actual linker
console.log('\n------------------------------');
console.log('Running linker against DB...');
console.log('------------------------------');
linkRecordingsToCallLogs(REC_DIR).then(result => {
  console.log('\nLinker result:', result);
  process.exit(0);
}).catch(err => {
  console.error('Linker error:', err);
  process.exit(1);
});
