/**
 * Generate self-signed SSL certificate
 * Run: node backend/scratch/gen_cert.js
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '../certs');
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

// Install selfsigned if needed
try { require('selfsigned'); } catch(_) {
  console.log('[SSL] Installing selfsigned...');
  execSync('npm install selfsigned', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
}

const selfsigned = require('selfsigned');

console.log('[SSL] Generating certificate...');

const pems = selfsigned.generate(
  [{ name: 'commonName', value: '192.168.0.205' }],
  {
    keySize:   2048,
    days:      365,
    algorithm: 'sha256',
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '192.168.0.205' },
        { type: 2, value: 'localhost' },
      ],
    }],
  }
);

fs.writeFileSync(path.join(certsDir, 'server.key'), pems.private);
fs.writeFileSync(path.join(certsDir, 'server.crt'), pems.cert);

console.log('[SSL] ✅ certs/server.key + certs/server.crt generated!');
console.log('[SSL] Valid for: 192.168.0.205, localhost | Expires: 365 days');
console.log('\nNext — update backend/.env on tower:');
console.log('  SSL_KEY_PATH=certs/server.key');
console.log('  SSL_CERT_PATH=certs/server.crt');
console.log('  MS_REDIRECT_URI=https://192.168.0.205:8088/auth/callback');
console.log('  APP_PUBLIC_URL=https://192.168.0.205:8088');
console.log('\nThen: pm2 restart unicomm');
console.log('Browser: https://192.168.0.205:8088 (accept the self-signed warning)');
