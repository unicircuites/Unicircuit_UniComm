/**
 * SMDR Simulator — sends fake call records to localhost SMDR port
 * Simulates Matrix PBX pushing SMDR data
 * Run: node backend/scratch/smdr_simulator.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const net = require('net');

const PORT = parseInt(process.env.SMDR_PORT || '5001');
const HOST = '127.0.0.1';

const callers = [
  '9198765XXXXX', '9187654XXXXX', '9176543XXXXX',
  'L&T ECC', 'BHEL Procurement', 'Adani Power',
  'Schneider Electric', 'Siemens India', 'ABB India',
];
const extensions = ['201', '202', '305', '108', '401'];
const trunks = ['T1', 'T2', 'SIP1', 'SIP2'];
const types = ['OUT', 'IN', 'IN', 'OUT', 'MISSED', 'INT'];

function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pad(n, len) { return String(n).padStart(len, '0'); }

function generateSMDRLine() {
  const now = new Date();
  const date = `${pad(now.getDate(),2)}/${pad(now.getMonth()+1,2)}/${String(now.getFullYear()).slice(2)}`;
  const time = `${pad(now.getHours(),2)}:${pad(now.getMinutes(),2)}:${pad(now.getSeconds(),2)}`;
  const dur  = `00:${pad(Math.floor(Math.random()*20),2)}:${pad(Math.floor(Math.random()*60),2)}`;
  const type = randomItem(types);
  const ext  = randomItem(extensions);
  const trunk = randomItem(trunks);
  const dest = randomItem(callers);
  return `${date}  ${time}  ${dur}  ${type}  ${ext}  ${trunk}  ${dest}\r\n`;
}

console.log(`[Simulator] Connecting to SMDR server at ${HOST}:${PORT}...`);

const client = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log('[Simulator] Connected! Sending fake SMDR records every 3 seconds...');
  console.log('[Simulator] Press Ctrl+C to stop\n');

  // Send one immediately
  const line = generateSMDRLine();
  console.log('[Simulator] Sending:', line.trim());
  client.write(line);

  // Then every 3 seconds
  const interval = setInterval(() => {
    const line = generateSMDRLine();
    console.log('[Simulator] Sending:', line.trim());
    client.write(line);
  }, 3000);

  client.on('close', () => {
    clearInterval(interval);
    console.log('[Simulator] Connection closed');
  });
});

client.on('error', (err) => {
  console.error('[Simulator] Error:', err.message);
  console.log('\nMake sure the UniComm server is running first: npm start');
  process.exit(1);
});
