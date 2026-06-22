module.exports = {
  apps: [
    {
      name: 'unicomm-backend',
      script: 'server.js',
      cwd: './backend',
      watch: false,
      env: {
        NODE_ENV: 'production',
        NODE_TLS_REJECT_UNAUTHORIZED: '0' // Accept self-signed certificates internally for Microsoft Entra and other endpoints
      }
    }
  ]
};
