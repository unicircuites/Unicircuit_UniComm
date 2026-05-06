/**
 * Generate self-signed SSL certificate using Node.js built-in crypto
 * Run: node backend/scratch/gen_cert.js
 * Output: backend/certs/server.key + backend/certs/server.crt
 */
const { generateKeyPairSync, createSign } = require('crypto');
const fs   = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '../certs');
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

console.log('[SSL] Generating RSA key pair...');
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Write private key
fs.writeFileSync(path.join(certsDir, 'server.key'), privateKey);
console.log('[SSL] ✅ server.key written');

// Build a minimal self-signed X.509 certificate using forge-like manual DER
// Since Node built-in doesn't have x509 cert generation, use the 'selfsigned' npm package
// Check if available, else use a pre-built approach

try {
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: '192.168.0.205' }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: [
        { type: 7, ip: '192.168.0.205' },
        { type: 2, value: 'localhost' },
      ]},
    ],
  });
  fs.writeFileSync(path.join(certsDir, 'server.key'), pems.private);
  fs.writeFileSync(path.join(certsDir, 'server.crt'), pems.cert);
  console.log('[SSL] ✅ server.key + server.crt generated via selfsigned');
  console.log('[SSL] Valid for: 192.168.0.205, localhost');
  console.log('[SSL] Expires: 365 days');
} catch(e) {
  console.log('[SSL] selfsigned not found, installing...');
  const { execSync } = require('child_process');
  execSync('npm install selfsigned', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
  // Re-run
  const selfsigned = require('selfsigned');
  const attrs = [{ name: 'commonName', value: '192.168.0.205' }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048, days: 365, algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames: [
      { type: 7, ip: '192.168.0.205' },
      { type: 2, value: 'localhost' },
    ]}],
  });
  fs.writeFileSync(path.join(certsDir, 'server.key'), pems.private);
  fs.writeFileSync(path.join(certsDir, 'server.crt'), pems.cert);
  console.log('[SSL] ✅ Done!');
}

console.log('\nNext steps:');
console.log('1. Update backend/.env:');
console.log('   SSL_KEY_PATH=certs/server.key');
console.log('   SSL_CERT_PATH=certs/server.crt');
console.log('   MS_REDIRECT_URI=https://192.168.0.205:8088/auth/callback');
console.log('   APP_PUBLIC_URL=https://192.168.0.205:8088');
console.log('2. pm2 restart unicomm');
console.log('3. Browser: https://192.168.0.205:8088 (accept self-signed warning)');
