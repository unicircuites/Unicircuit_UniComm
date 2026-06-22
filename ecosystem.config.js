module.exports = {
  apps: [
    {
      name: 'unicomm-backend',
      script: 'server.js',
      cwd: './backend',
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'n8n',
      script: 'npx',
      args: 'n8n',
      cwd: '.',
      watch: false,
      env: {
        N8N_DISABLE_UI_SECURITY: 'true'
      }
    }
  ]
};
