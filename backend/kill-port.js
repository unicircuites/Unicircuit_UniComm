const { execSync } = require('child_process');

function killPort(port) {
  try {
    console.log(`Checking for processes on port ${port}...`);
    let cmd = '';
    if (process.platform === 'win32') {
      cmd = `netstat -ano | findstr :${port}`;
    } else {
      cmd = `lsof -i tcp:${port} -t`;
    }

    const output = execSync(cmd).toString().trim();
    if (output) {
      const lines = output.split('\n');
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pid = process.platform === 'win32' ? parts[parts.length - 1] : parts[0];
        if (pid && pid !== '0') {
          console.log(`Killing process ${pid} on port ${port}...`);
          try {
            execSync(`taskkill /F /PID ${pid} /T`);
          } catch (e) {
            // Taskkill might fail if process already exited
          }
        }
      });
    } else {
      console.log(`No process found on port ${port}.`);
    }
  } catch (err) {
    // If findstr returns nothing, it throws an error in execSync
    console.log(`Port ${port} is likely free.`);
  }
}

killPort(8088);
