const fs = require('fs');
const path = require('path');

// Determine if we are running in SSL mode by parsing backend/.env
let n8nEnv = {
  N8N_DISABLE_UI_SECURITY: 'true',
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false'
};

let backendEnv = {
  NODE_ENV: 'production',
  NODE_TLS_REJECT_UNAUTHORIZED: '0' // Accept self-signed certificates internally (e.g. for HTTPS webhooks/Microsoft Graph)
};

const envPath = path.join(__dirname, 'backend', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envConfig = {};
  envContent.split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (match) {
      envConfig[match[1]] = match[2].trim();
    }
  });

  const sslKey = envConfig.SSL_KEY_PATH;
  const sslCert = envConfig.SSL_CERT_PATH;
  if (sslKey && sslCert) {
    const keyPath = path.isAbsolute(sslKey) ? sslKey : path.join(__dirname, 'backend', sslKey);
    const certPath = path.isAbsolute(sslCert) ? sslCert : path.join(__dirname, 'backend', sslCert);
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      n8nEnv.N8N_PROTOCOL = 'https';
      n8nEnv.N8N_SSL_KEY = keyPath;
      n8nEnv.N8N_SSL_CERT = certPath;
    }
  }
}

module.exports = {
  apps: [
    {
      name: 'unicomm-backend',
      script: 'server.js',
      cwd: './backend',
      watch: false,
      env: backendEnv
    },
    {
      name: 'n8n',
      script: 'cmd.exe',
      args: ['/c', 'n8n'],
      cwd: '.',
      watch: false,
      env: n8nEnv
    }
  ]
};
