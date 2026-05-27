const fs = require('fs');
const net = require('net');
const path = require('path');

const PBX_IP = '192.168.0.81';
const LOCAL_VMS_DIR = 'C:\\MatrixVMS\\Voicemail_Backup';

console.log('====================================================');
console.log(' MATRIX VMS & CONNECTION DIAGNOSTIC TOOL');
console.log('====================================================\n');

// 1. Check Local VMS Directory
console.log('[STEP 1] Checking Local Storage Directory...');
if (fs.existsSync(LOCAL_VMS_DIR)) {
    console.log(`✅ Directory exists: ${LOCAL_VMS_DIR}`);
    try {
        const files = fs.readdirSync(LOCAL_VMS_DIR);
        console.log(`   Found ${files.length} items in the directory.`);
        if (files.length > 0) {
            console.log(`   Sample files: ${files.slice(0, 3).join(', ')}`);
        }
    } catch (e) {
        console.log(`❌ Cannot read directory: ${e.message}`);
    }
} else {
    console.log(`❌ Directory does NOT exist: ${LOCAL_VMS_DIR}`);
    console.log(`   Creating directory to fix potential storage issues...`);
    try {
        fs.mkdirSync(LOCAL_VMS_DIR, { recursive: true });
        console.log(`✅ Directory created successfully.`);
    } catch (e) {
        console.log(`❌ Failed to create directory: ${e.message}`);
    }
}
console.log();

// 2. Probing PBX for exposed VMS interfaces
console.log('[STEP 2] Probing PBX Interfaces to check how it shares recordings...');
const checkPort = (port, name) => {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(3000);
        socket.on('connect', () => {
            console.log(`✅ PBX Interface OPEN: ${name} (Port ${port})`);
            
            if (port === 22) {
                socket.on('data', (data) => {
                    console.log(`   [Banner ${port}] ${data.toString().trim()}`);
                    socket.destroy();
                });
            } else {
                socket.destroy();
            }
        });
        socket.on('timeout', () => {
            console.log(`❌ PBX Interface CLOSED/TIMEOUT: ${name} (Port ${port})`);
            socket.destroy();
        });
        socket.on('error', () => {
            console.log(`❌ PBX Interface CLOSED: ${name} (Port ${port})`);
            resolve();
        });
        socket.on('close', resolve);
        socket.connect(port, PBX_IP);
    });
};

async function runTests() {
    await checkPort(21, 'FTP (VMS Pull)');
    await checkPort(22, 'SSH (System Shell)');
    await checkPort(80, 'HTTP (Legacy API)');
    await checkPort(445, 'SMB/CIFS (Windows Share)');
    console.log();

    // 3. Start a Mock FTP Server to see if PBX is trying to PUSH recordings
    console.log('[STEP 3] Starting Mock FTP Server to catch incoming PBX connections...');
    console.log('         (Matrix PBX often pushes Voicemail via FTP when a call ends)');
    
    const ftpServer = net.createServer((socket) => {
        console.log(`\n[FTP] 📞 Incoming connection from PBX: ${socket.remoteAddress}`);
        socket.write("220 Matrix Diagnostic FTP Server Ready\r\n");

        socket.on('data', (data) => {
            const cmd = data.toString().trim();
            console.log(`[FTP CMD] <- ${cmd}`);
            
            if (cmd.startsWith('USER')) socket.write("331 Password required\r\n");
            else if (cmd.startsWith('PASS')) socket.write("230 User logged in\r\n");
            else if (cmd.startsWith('SYST')) socket.write("215 UNIX Type: L8\r\n");
            else if (cmd.startsWith('PWD')) socket.write("257 \"/\" is current directory.\r\n");
            else if (cmd.startsWith('QUIT')) {
                socket.write("221 Goodbye\r\n");
                socket.end();
            }
            else socket.write("200 OK\r\n");
        });
        
        socket.on('error', err => console.log(`[FTP ERR] ${err.message}`));
    });

    ftpServer.on('error', (err) => {
        if (err.code === 'EACCES') {
            console.log(`❌ Failed to start FTP server on Port 21 (Permission Denied).`);
            console.log(`   You might need to run this script as Administrator.`);
        } else if (err.code === 'EADDRINUSE') {
            console.log(`❌ Failed to start FTP server. Port 21 is already in use.`);
            console.log(`   Another FTP Server (like FileZilla or IIS) is already running and might be receiving the files!`);
        } else {
            console.log(`❌ FTP Server error: ${err.message}`);
        }
        process.exit();
    });

    ftpServer.listen(21, '0.0.0.0', () => {
        console.log(`✅ Listening on Port 21 for PBX FTP pushes.`);
        console.log(`   Waiting for connections... (Make a test call and hang up to see if it sends the recording)`);
    });
}

runTests();
