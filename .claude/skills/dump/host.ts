/**
 * Dump Skill - IPC Handler (Host Side)
 *
 * Watches for dump tasks from container agents.
 * Calls scripts/dump.ts as subprocess with task params.
 * Writes results back to dump_results IPC dir.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

// Import env reader (same as container-runner.ts uses for security)
function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    return result;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [key, ...rest] = trimmed.split('=');
    const cleanKey = key.trim();

    if (keys.includes(cleanKey)) {
      const value = rest.join('=').trim().replace(/^"|"$/g, '');
      result[cleanKey] = value;
    }
  }

  return result;
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'dump_results');

// Ensure results dir exists
fs.mkdirSync(RESULTS_DIR, { recursive: true });

interface DumpTask {
  type: string;
  taskId: string;
  params: {
    tags: string[];
    tasks: string[];
  };
}

interface SkillResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: unknown;
}

/**
 * Read only the secrets dump.ts needs (whitelist).
 * Secrets are never logged or exposed to child processes via env.
 */
function readDumpSecrets(): Record<string, string> {
  return readEnvFile(['NOTES_URL', 'SHLINK_URL', 'SHLINK_API_KEY', 'SHLINK']);
}

/**
 * Run the dump script as a subprocess.
 * Passes params + secrets via stdin (secure), reads JSON result from stdout.
 * Environment is minimal — no secrets leak to process.env.
 */
function runDumpScript(params: object): Promise<SkillResult> {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'dump.ts');

    // Read only whitelisted secrets
    const secrets = readDumpSecrets();

    const proc = spawn('npx', ['ts-node', '--project', 'tsconfig.json', scriptPath], {
      cwd: __dirname,
      // Minimal env — no secrets leaked via process.env
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        TZ: process.env.TZ,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pass params + secrets via stdin (secure, never in process.env or argv)
    const input = JSON.stringify({ params, secrets });
    proc.stdin.write(input);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error({ stderr, code }, 'dump script exited with error');
        resolve({
          success: false,
          error: stderr || `Script exited with code ${code}`,
        });
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        logger.error({ stdout }, 'Failed to parse dump script output');
        resolve({
          success: false,
          error: `Invalid script output: ${stdout}`,
        });
      }
    });
  });
}

/**
 * Process a single dump task file.
 */
async function handleTask(taskFile: string) {
  if (!fs.existsSync(taskFile)) return;

  let task: DumpTask;
  try {
    task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
    fs.unlinkSync(taskFile);
  } catch (err) {
    logger.error({ err, taskFile }, 'Failed to read/parse task file');
    return;
  }

  // Only handle dump tasks
  if (task.type !== 'dump') return;

  logger.info({ taskId: task.taskId, tags: task.params.tags }, 'Processing dump task');

  const result = await runDumpScript(task.params);

  const resultFile = path.join(RESULTS_DIR, `${task.taskId}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(result));

  logger.info({ taskId: task.taskId, success: result.success }, 'Dump task complete');
}

/**
 * Directly run a dump from the host (Claude Code / host CLI).
 * Bypasses IPC — calls dump script directly.
 */
export async function runDump(params: { tags: string[]; tasks: string[] }): Promise<SkillResult> {
  return runDumpScript(params);
}

/**
 * Start watching the IPC tasks directory for dump tasks.
 * Called by the main NanoClaw host process.
 */
export function startDumpWatcher() {
  fs.watch(TASKS_DIR, async (_, filename) => {
    if (!filename?.endsWith('.json')) return;
    if (!filename.startsWith('dump-')) return;

    const taskFile = path.join(TASKS_DIR, filename);

    // Small delay to ensure file is fully written
    await new Promise(r => setTimeout(r, 50));

    await handleTask(taskFile);
  });

  logger.info('Dump IPC watcher started');
}
