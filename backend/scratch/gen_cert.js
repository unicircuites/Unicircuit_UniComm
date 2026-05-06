/**
 * Generate self-signed SSL certificate
 * Run: node backend/scratch/gen_cert.js
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '../certs');
if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });

const keyFile = path.join(certsDir, 'server.key');
const crtFile = path.join(certsDir, 'server.crt');

// Try node-forge — most reliable, pure JS
function tryForge() {
  let forge;
  try { forge = require('node-forge'); } catch(_) {
    console.log('[SSL] Installing node-forge...');
    execSync('npm install node-forge', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    forge = require('node-forge');
  }
  console.log('[SSL] Generating with node-forge...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: 'commonName', value: '192.168.0.205' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{
    name: 'subjectAltName',
    altNames: [
      { type: 7, ip: '192.168.0.205' },
      { type: 2, value: 'localhost' },
    ]
  }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  fs.writeFileSync(keyFile, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(crtFile, forge.pki.certificateToPem(cert));
  console.log('[SSL] ✅ server.key + server.crt generated!');
}

tryForge();

console.log('\nNext — update backend/.env on tower:');
console.log('  SSL_KEY_PATH=certs/server.key');
console.log('  SSL_CERT_PATH=certs/server.crt');
console.log('  MS_REDIRECT_URI=https://192.168.0.205:8088/auth/callback');
console.log('  APP_PUBLIC_URL=https://192.168.0.205:8088');
console.log('\nThen: pm2 restart unicomm');
console.log('Browser: https://192.168.0.205:8088 (accept the self-signed warning)');
