const { spawn } = require('child_process');
const path = require('path');

console.log('\x1b[36m%s\x1b[0m', '===================================================');
console.log('\x1b[36m%s\x1b[0m', '      Unicircuit CRM & n8n Service Manager       ');
console.log('\x1b[36m%s\x1b[0m', '===================================================');

// Helper to prefix output
function prefixOutput(stream, prefix, colorCode) {
  let buffer = '';
  stream.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep last incomplete line
    for (const line of lines) {
      console.log(`${colorCode}${prefix}\x1b[0m | ${line}`);
    }
  });
}

// 1. Start n8n
console.log('\x1b[33m%s\x1b[0m', '[n8n] Starting n8n with UI security disabled...');
const n8nEnv = { 
  ...process.env, 
  N8N_DISABLE_UI_SECURITY: 'true',
  N8N_PORT: '5678',
  N8N_HOST: '127.0.0.1'
};
const n8nProcess = spawn('npx -y n8n', {
  env: n8nEnv,
  shell: true
});
prefixOutput(n8nProcess.stdout, '[n8n]', '\x1b[35m'); // Magenta
prefixOutput(n8nProcess.stderr, '[n8n]', '\x1b[31m');

// 2. Start CRM Backend
console.log('\x1b[33m%s\x1b[0m', '[CRM] Starting CRM backend (npm run dev)...');
const backendDir = path.join(__dirname, 'backend');
const backendProcess = spawn('npm run dev', {
  cwd: backendDir,
  shell: true
});
prefixOutput(backendProcess.stdout, '[CRM]', '\x1b[32m'); // Green
prefixOutput(backendProcess.stderr, '[CRM]', '\x1b[31m');

// Handle termination signals to cleanly shut down both processes
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n\x1b[31m%s\x1b[0m', 'Shutting down all services...');
  
  // Kill processes using taskkill on Windows to ensure all child shells are killed
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    console.log('[System] Force-killing process trees on Windows...');
    spawnSync('taskkill', ['/pid', n8nProcess.pid, '/f', '/t']);
    spawnSync('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
  } else {
    n8nProcess.kill();
    backendProcess.kill();
  }
  
  setTimeout(() => {
    process.exit();
  }, 500);
};

// If either process exits, shut down the other one too
n8nProcess.on('close', (code) => {
  if (!shuttingDown) {
    console.log(`\n\x1b[31m[n8n] Process exited unexpectedly with code ${code}. Shutting down remaining services...\x1b[0m`);
    shutdown();
  }
});

backendProcess.on('close', (code) => {
  if (!shuttingDown) {
    console.log(`\n\x1b[31m[CRM] Process exited unexpectedly with code ${code}. Shutting down remaining services...\x1b[0m`);
    shutdown();
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);
