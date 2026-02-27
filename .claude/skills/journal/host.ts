/**
 * Journal Skill - IPC Handler (Host Side)
 *
 * Watches for journal tasks from container agents.
 * Calls journal.ts as subprocess with task params.
 * Writes results back to journal_results IPC dir.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

/**
 * Read whitelisted keys from .env file.
 */
function readEnvFile(keys: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    const envPath = path.join(process.cwd(), '.env');

    if (!fs.existsSync(envPath)) return result;

    const content = fs.readFileSync(envPath, 'utf-8');

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const [key, ...rest] = trimmed.split('=');
        const cleanKey = key.trim();

        if (keys.includes(cleanKey)) {
            result[cleanKey] = rest.join('=').trim().replace(/^"|"$/g, '');
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
const RESULTS_DIR = path.join(IPC_DIR, 'journal_results');

// Ensure results dir exists
fs.mkdirSync(RESULTS_DIR, { recursive: true });

interface JournalTask {
    type: string;
    taskId: string;
    params: {
        content: string;
    };
}

interface SkillResult {
    success: boolean;
    message?: string;
    error?: string;
    data?: unknown;
}

/**
 * Read only the secrets journal.ts needs (whitelist).
 */
function readJournalSecrets(): Record<string, string> {
    return readEnvFile(['NOTES_URL', 'SHLINK_URL', 'SHLINK_API_KEY', 'SHLINK']);
}

/**
 * Run the journal script as a subprocess.
 * Passes params + secrets via stdin (secure), reads JSON result from stdout.
 */
function runJournalScript(params: object): Promise<SkillResult> {
    return new Promise((resolve) => {
        const scriptPath = path.join(__dirname, 'journal.ts');
        const secrets = readJournalSecrets();

        const proc = spawn('npx', ['ts-node', '--project', 'tsconfig.json', scriptPath], {
            cwd: __dirname,
            // Minimal env — no secrets leaked via process.env
            env: {
                NODE_ENV: process.env.NODE_ENV || 'production',
                TZ: process.env.TZ,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Pass params + secrets via stdin (secure)
        const input = JSON.stringify({ params, secrets });
        proc.stdin.write(input);
        proc.stdin.end();

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => (stdout += d.toString()));
        proc.stderr.on('data', (d) => (stderr += d.toString()));

        proc.on('close', (code) => {
            if (code !== 0) {
                logger.error({ stderr, code }, 'journal script exited with error');
                resolve({
                    success: false,
                    error: stderr || `Script exited with code ${code}`,
                });
                return;
            }

            try {
                resolve(JSON.parse(stdout.trim()));
            } catch {
                logger.error({ stdout }, 'Failed to parse journal script output');
                resolve({
                    success: false,
                    error: `Invalid script output: ${stdout}`,
                });
            }
        });
    });
}

/**
 * Process a single journal task file.
 */
async function handleTask(taskFile: string) {
    if (!fs.existsSync(taskFile)) return;

    let task: JournalTask;
    try {
        task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
        fs.unlinkSync(taskFile);
    } catch (err) {
        logger.error({ err, taskFile }, 'Failed to read/parse task file');
        return;
    }

    if (task.type !== 'journal') return;

    logger.info({ taskId: task.taskId }, 'Processing journal task');

    const result = await runJournalScript(task.params);

    const resultFile = path.join(RESULTS_DIR, `${task.taskId}.json`);
    fs.writeFileSync(resultFile, JSON.stringify(result));

    logger.info({ taskId: task.taskId, success: result.success }, 'Journal task complete');
}

/**
 * Directly run a journal entry from the host (Claude Code / host CLI).
 * Bypasses IPC — calls journal script directly.
 */
export async function runJournal(params: { content: string }): Promise<SkillResult> {
    return runJournalScript(params);
}

/**
 * Start watching the IPC tasks directory for journal tasks.
 * Called by the main host process.
 */
export function startJournalWatcher() {
    fs.watch(TASKS_DIR, async (_, filename) => {
        if (!filename?.endsWith('.json')) return;
        if (!filename.startsWith('journal-')) return;

        const taskFile = path.join(TASKS_DIR, filename);

        // Small delay to ensure file is fully written
        await new Promise(r => setTimeout(r, 50));

        await handleTask(taskFile);
    });

    logger.info('Journal IPC watcher started');
}
