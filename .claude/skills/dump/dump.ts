/**
 * Dump Script - Vault File Operations Only
 *
 * Called by host.ts as a subprocess.
 * Receives params via stdin.
 * Writes JSON result to stdout.
 *
 * Responsibilities:
 * - Write tasks to /opt/vault/dumps/{tag}.md
 * - Append with timestamp, never overwrite
 * - Initialize file header if new file
 * - Return structured result with vaultPath for URL chaining
 *
 * URL building + shortening is handled by the MCP layer via
 * get_vault_url and get_short_url chain tools.
 */

import fs from 'fs';
import path from 'path';

// ─── Config ────────────────────────────────────────────────────────────────

const VAULT_PATH = process.env.NANOCLAW_VAULT_PATH || '/opt/vault';
const DUMPS_DIR = path.join(VAULT_PATH, 'dumps');

// ─── Types ─────────────────────────────────────────────────────────────────

interface DumpInput {
    params: {
        tags: string[];
        tasks: string[];
    };
}

interface TagResult {
    tag: string;
    taskCount: number;
    filePath: string;
    vaultPath: string; // relative path for get_vault_url, e.g. "dumps/my-tag.md"
}

interface DumpResult {
    success: boolean;
    error?: string;
    results?: TagResult[];
}

// ─── Timestamp ─────────────────────────────────────────────────────────────

/**
 * Format current time as: DD/MM/YYYY H:MM:SS AM/PM
 */
function formatTimestamp(): string {
    const now = new Date();

    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();

    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';

    hours = hours % 12;
    if (hours === 0) hours = 12;

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds} ${ampm}`;
}

// ─── File Operations ────────────────────────────────────────────────────────

function buildEntryBlock(tasks: string[]): string {
    const timestamp = formatTimestamp();
    return `${timestamp}\n${tasks.join('\n')}\n---\n`;
}

function buildFileHeader(tag: string): string {
    return `# ${tag}\n#${tag}\n`;
}

function writeTagFile(tag: string, tasks: string[]): string {
    fs.mkdirSync(DUMPS_DIR, { recursive: true });

    const filePath = path.join(DUMPS_DIR, `${tag}.md`);
    const entry = buildEntryBlock(tasks);

    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buildFileHeader(tag) + entry, 'utf-8');
    } else {
        fs.appendFileSync(filePath, entry, 'utf-8');
    }

    return filePath;
}

// ─── Stdin Reader ───────────────────────────────────────────────────────────

function readInput(): Promise<DumpInput> {
    return new Promise((resolve, reject) => {
        let data = '';

        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data) as DumpInput);
            } catch (err) {
                reject(new Error(`Failed to parse stdin: ${(err as Error).message}`));
            }
        });
        process.stdin.on('error', reject);
    });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const input = await readInput();
    const { tags, tasks } = input.params;

    if (!tags || tags.length === 0) {
        console.log(JSON.stringify({ success: false, error: 'No tags provided.' } as DumpResult));
        return;
    }

    if (!tasks || tasks.length === 0) {
        console.log(JSON.stringify({ success: false, error: 'Task/todo is missing.' } as DumpResult));
        return;
    }

    const tagResults: TagResult[] = [];

    for (const tag of tags) {
        try {
            const filePath = writeTagFile(tag, tasks);
            const vaultPath = filePath.replace(VAULT_PATH, '').replace(/^\//, '');

            tagResults.push({ tag, taskCount: tasks.length, filePath, vaultPath });
        } catch (err) {
            console.log(JSON.stringify({
                success: false,
                error: `Failed to write #${tag}: ${(err as Error).message}`,
            } as DumpResult));
            return;
        }
    }

    console.log(JSON.stringify({ success: true, results: tagResults } as DumpResult));
}

main().catch(err => {
    console.log(JSON.stringify({ success: false, error: `Unexpected error: ${err.message}` } as DumpResult));
    process.exit(1);
});
