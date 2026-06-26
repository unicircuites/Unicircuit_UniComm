const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

console.log(
  "\x1b[36m%s\x1b[0m",
  "===================================================",
);
console.log(
  "\x1b[36m%s\x1b[0m",
  "      Unicircuit CRM & n8n Service Manager       ",
);
console.log(
  "\x1b[36m%s\x1b[0m",
  "===================================================",
);

// Helper to prefix output
function prefixOutput(stream, prefix, colorCode) {
  let buffer = "";
  stream.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep last incomplete line
    for (const line of lines) {
      console.log(`${colorCode}${prefix}\x1b[0m | ${line}`);
    }
  });
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(1200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function killProcessTree(childProcess) {
  if (!childProcess || childProcess.killed) return;
  if (process.platform === "win32") {
    const { spawnSync } = require("child_process");
    spawnSync("taskkill", ["/pid", childProcess.pid, "/f", "/t"]);
  } else {
    childProcess.kill();
  }
}

let n8nProcess = null;
let backendProcess = null;

async function startServices() {
  // 1. Start n8n locally only if port 5678 is not already serving.
  if (await isPortOpen(5678)) {
    console.log(
      "\x1b[32m[n8n] Already running locally at http://localhost:5678\x1b[0m",
    );
  } else {
    console.log(
      "\x1b[33m%s\x1b[0m",
      "[n8n] Starting local n8n with UI security disabled...",
    );
    const n8nEnv = {
      ...process.env,
      N8N_DISABLE_UI_SECURITY: "true",
      N8N_PORT: "5678",
      N8N_HOST: "127.0.0.1",
      N8N_PROTOCOL: "http",
      N8N_EDITOR_BASE_URL: "http://localhost:5678",
      WEBHOOK_URL: "http://localhost:5678",
    };
    n8nProcess = spawn("npx -y n8n", {
      env: n8nEnv,
      shell: true,
    });
    prefixOutput(n8nProcess.stdout, "[n8n]", "\x1b[35m"); // Magenta
    prefixOutput(n8nProcess.stderr, "[n8n]", "\x1b[31m");
  }

  // 2. Start CRM Backend only if port 8088 is not already serving.
  if (await isPortOpen(8088)) {
    console.log(
      "\x1b[32m[CRM] Already running locally at http://localhost:8088\x1b[0m",
    );
  } else {
    console.log(
      "\x1b[33m%s\x1b[0m",
      "[CRM] Starting CRM backend (npm run dev)...",
    );
    const backendDir = path.join(__dirname, "backend");
    backendProcess = spawn("npm run dev", {
      cwd: backendDir,
      shell: true,
    });
    prefixOutput(backendProcess.stdout, "[CRM]", "\x1b[32m"); // Green
    prefixOutput(backendProcess.stderr, "[CRM]", "\x1b[31m");
  }

  attachProcessHandlers();
}

startServices().catch((error) => {
  console.error("\x1b[31m[System] Failed to start services:\x1b[0m", error);
  process.exitCode = 1;
});

// Handle termination signals to cleanly shut down both processes
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n\x1b[31m%s\x1b[0m", "Shutting down all services...");

  console.log("[System] Stopping processes started by this service manager...");
  killProcessTree(n8nProcess);
  killProcessTree(backendProcess);

  setTimeout(() => {
    process.exit();
  }, 500);
};

function attachProcessHandlers() {
  // If either process exits, shut down the other one too.
  // Processes that were already running before this script started are left alone.
  if (n8nProcess) {
    n8nProcess.on("close", (code) => {
      if (!shuttingDown) {
        console.log(
          `\n\x1b[31m[n8n] Process exited unexpectedly with code ${code}. Shutting down remaining services...\x1b[0m`,
        );
        shutdown();
      }
    });
  }

  if (backendProcess) {
    backendProcess.on("close", (code) => {
      if (!shuttingDown) {
        console.log(
          `\n\x1b[31m[CRM] Process exited unexpectedly with code ${code}. Shutting down remaining services...\x1b[0m`,
        );
        shutdown();
      }
    });
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
