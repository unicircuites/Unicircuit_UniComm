const net = require('net');

const PBX_HOST = '192.168.0.81';
const portsToTest = [40, 5000, 5001, 5002];

console.log(`\n🔍 Probing Matrix PBX at ${PBX_HOST}...`);
console.log('-------------------------------------------');

function checkPort(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);

        socket.on('connect', () => {
            console.log(`✅ Port ${port.toString().padEnd(5)}: OPEN (Something is listening here)`);
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            console.log(`❌ Port ${port.toString().padEnd(5)}: TIMEOUT (No response)`);
            socket.destroy();
            resolve(false);
        });

        socket.on('error', (err) => {
            console.log(`❌ Port ${port.toString().padEnd(5)}: CLOSED (${err.code})`);
            resolve(false);
        });

        socket.connect(port, PBX_HOST);
    });
}

async function runTest() {
    for (const port of portsToTest) {
        await checkPort(port);
    }
    console.log('-------------------------------------------');
    console.log('Test complete.\n');
}

runTest();
