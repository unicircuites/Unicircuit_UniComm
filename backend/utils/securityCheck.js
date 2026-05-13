/**
 * Security Check Utilities
 * Validates file permissions and security configurations on startup
 */

const fs = require('fs');
const path = require('path');

/**
 * Check if .env file has secure permissions (Unix-like systems)
 * On Windows, this check is informational only
 */
function checkEnvFilePermissions() {
  const envPath = path.join(__dirname, '..', '.env');
  
  if (!fs.existsSync(envPath)) {
    console.warn('[Security] ⚠️  .env file not found');
    return false;
  }
  
  try {
    const stats = fs.statSync(envPath);
    
    // On Unix-like systems, check file permissions
    if (process.platform !== 'win32') {
      const mode = stats.mode & parseInt('777', 8);
      const octal = mode.toString(8);
      
      // Warn if file is readable by group or others
      if (mode & parseInt('077', 8)) {
        console.warn(`[Security] ⚠️  .env file has insecure permissions: ${octal}`);
        console.warn('[Security] 💡 Recommended: chmod 600 .env (owner read/write only)');
        return false;
      }
      
      console.log(`[Security] ✅ .env file permissions OK: ${octal}`);
      return true;
    } else {
      // Windows - just check if file exists and is readable
      console.log('[Security] ℹ️  .env file found (Windows - permission check skipped)');
      console.log('[Security] 💡 Ensure .env file is not accessible to unauthorized users');
      return true;
    }
  } catch (err) {
    console.error('[Security] Error checking .env permissions:', err.message);
    return false;
  }
}

/**
 * Check for sensitive data in environment variables
 */
function checkSensitiveEnvVars() {
  const warnings = [];
  
  // Check for default/weak secrets
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'unicomm_secret' || jwtSecret.length < 32) {
    warnings.push('JWT_SECRET is weak or using default value');
  }
  
  // Check for missing critical env vars
  const critical = ['DB_PASSWORD', 'MS_CLIENT_SECRET', 'AI_API_KEY'];
  for (const key of critical) {
    if (!process.env[key]) {
      warnings.push(`${key} is not set`);
    }
  }
  
  if (warnings.length > 0) {
    console.warn('[Security] ⚠️  Environment variable warnings:');
    warnings.forEach(w => console.warn(`  - ${w}`));
    return false;
  }
  
  console.log('[Security] ✅ Environment variables OK');
  return true;
}

/**
 * Check SSL/TLS configuration
 */
function checkSSLConfig() {
  const sslKey = process.env.SSL_KEY_PATH;
  const sslCert = process.env.SSL_CERT_PATH;
  
  if (!sslKey || !sslCert) {
    console.warn('[Security] ⚠️  SSL/TLS not configured - server running on HTTP');
    console.warn('[Security] 💡 For production, configure SSL_KEY_PATH and SSL_CERT_PATH');
    return false;
  }
  
  // Check if SSL files exist
  const keyPath = path.isAbsolute(sslKey) ? sslKey : path.join(__dirname, '..', sslKey);
  const certPath = path.isAbsolute(sslCert) ? sslCert : path.join(__dirname, '..', sslCert);
  
  if (!fs.existsSync(keyPath)) {
    console.error('[Security] ❌ SSL key file not found:', keyPath);
    return false;
  }
  
  if (!fs.existsSync(certPath)) {
    console.error('[Security] ❌ SSL certificate file not found:', certPath);
    return false;
  }
  
  console.log('[Security] ✅ SSL/TLS configured');
  return true;
}

/**
 * Run all security checks on startup
 */
function runStartupSecurityChecks() {
  console.log('\n[Security] Running startup security checks...\n');
  
  const checks = [
    checkEnvFilePermissions(),
    checkSensitiveEnvVars(),
    checkSSLConfig(),
  ];
  
  const passed = checks.filter(Boolean).length;
  const total = checks.length;
  
  console.log(`\n[Security] Security checks: ${passed}/${total} passed\n`);
  
  if (passed < total) {
    console.warn('[Security] ⚠️  Some security checks failed - review warnings above');
  }
  
  return passed === total;
}

module.exports = {
  runStartupSecurityChecks,
  checkEnvFilePermissions,
  checkSensitiveEnvVars,
  checkSSLConfig,
};
