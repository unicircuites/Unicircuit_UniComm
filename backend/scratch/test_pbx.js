const net = require('net');
const PBX_HOST = '192.168.0.81';
const SMDR_PORT = 5000;
const CTI_PORT = 5001;

function testPort(port, name) {
  return new Promise((resolve) => {
    console.log(`Testing ${name} on ${PBX_HOST}:${port}...`);
    const socket = new net.Socket();
    const timeout = 3000;
    socket.setTimeout(timeout);

    socket.on('connect', () => {
      console.log(`✅ ${name} (${port}) is OPEN / PBX is acting as Server`);
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      console.log(`❌ ${name} (${port}) TIMEOUT / Port closed or PBX not reachable`);
      socket.destroy();
      resolve(false);
    });

    socket.on('error', (err) => {
      console.log(`❌ ${name} (${port}) ERROR: ${err.message}`);
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, PBX_HOST);
  });
}

async function run() {
  await testPort(SMDR_PORT, 'SMDR');
  await testPort(CTI_PORT, 'CTI');
  process.exit(0);
}

run();
