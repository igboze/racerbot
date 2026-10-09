import { fork, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WorkerConfig {
  name: string;
  relativePath: string;
  enabled: boolean;
}

const activeWorkers = new Map<string, ChildProcess>();
let isShuttingDown = false;

/**
 * Spawns background worker processes (detector, executor, triggers)
 * when running in single-service environments such as Railway.
 */
export function startBackgroundWorkers(): void {
  if (
    process.env.DISABLE_BACKGROUND_WORKERS === 'true' ||
    process.env.RAILWAY_SERVICE_NAME === 'api' ||
    process.env.RAILWAY_SERVICE_NAME === 'bot'
  ) {
    console.log('[WORKERS] Background workers disabled in multi-service deployment');
    return;
  }

  isShuttingDown = false;

  const workers: WorkerConfig[] = [
    {
      name: 'detector',
      relativePath: '../../detector/dist/index.js',
      enabled: process.env.ENABLE_DETECTOR !== 'false',
    },
    {
      name: 'executor',
      relativePath: '../../executor/dist/index.js',
      enabled: process.env.ENABLE_EXECUTOR !== 'false',
    },
    {
      name: 'triggers',
      relativePath: '../../triggers/dist/index.js',
      enabled: process.env.ENABLE_TRIGGERS !== 'false',
    },
  ];

  for (const w of workers) {
    if (!w.enabled) continue;
    spawnWorker(w);
  }
}

function spawnWorker(config: WorkerConfig): void {
  if (isShuttingDown) return;

  const fullPath = path.resolve(__dirname, config.relativePath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`[WORKERS] Worker script not found at ${fullPath}. Skipping ${config.name}.`);
    return;
  }

  console.log(`[WORKERS] Starting background worker: ${config.name} (${fullPath})`);
  const child = fork(fullPath, [], {
    env: { ...process.env },
    stdio: 'inherit',
  });

  activeWorkers.set(config.name, child);

  child.on('error', (err) => {
    console.error(`[WORKERS] Worker ${config.name} process error:`, err);
  });

  child.on('exit', (code, signal) => {
    activeWorkers.delete(config.name);
    if (isShuttingDown) return;

    console.warn(
      `[WORKERS] Worker ${config.name} exited (code: ${code}, signal: ${signal}). Auto-restarting in 5s...`
    );
    setTimeout(() => {
      spawnWorker(config);
    }, 5000);
  });
}

/**
 * Cleanly stops all spawned background workers.
 */
export function stopBackgroundWorkers(): void {
  isShuttingDown = true;
  for (const [name, child] of activeWorkers.entries()) {
    try {
      console.log(`[WORKERS] Terminating ${name} worker...`);
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  activeWorkers.clear();
}
