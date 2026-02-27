/**
 * Journal Script - Vault File Operations Only
 *
 * Called by host.ts as a subprocess.
 * Receives params via stdin.
 * Writes JSON result to stdout.
 *
 * Responsibilities:
 * - Append entry to /opt/vault/journal/{DD-MM-YYYY}-journal.md
 * - Initialize file header if new file
 * - Never overwrite existing entries
 * - Return structured result with vaultPath for URL chaining
 *
 * URL building + shortening is handled by the MCP layer via
 * get_vault_url and get_short_url chain tools.
 */

import fs from 'fs';
import path from 'path';

// ─── Config ────────────────────────────────────────────────────────────────

const VAULT_PATH = process.env.NANOCLAW_VAULT_PATH || '/opt/vault';
const JOURNAL_DIR = path.join(VAULT_PATH, 'journal');

// ─── Types ─────────────────────────────────────────────────────────────────

interface JournalInput {
    params: {
        content: string;
    };
}

interface JournalResult {
    success: boolean;
    filePath?: string;
    vaultPath?: string; // relative path for get_vault_url, e.g. "journal/25-02-2026-journal.md"
    filename?: string;
    error?: string;
}

// ─── Timestamp & Date Helpers ──────────────────────────────────────────────

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

    hours = hours % 12 || 12;

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds} ${ampm}`;
}

function getTodayFilename(): { display: string; filename: string } {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();

    const display = `${day}/${month}/${year}`;
    const filename = `${day}-${month}-${year}-journal.md`;

    return { display, filename };
}

// ─── File Operations ────────────────────────────────────────────────────────

function buildFileHeader(dateDisplay: string): string {
    return `# ${dateDisplay} Journal\n#daily-journal\n`;
}

function buildEntryBlock(content: string): string {
    const timestamp = formatTimestamp();
    return `\n***${timestamp}***\n${content}\n\n---\n`;
}

function writeJournalEntry(content: string): { filePath: string; display: string; filename: string } {
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });

    const { display, filename } = getTodayFilename();
    const filePath = path.join(JOURNAL_DIR, filename);
    const entry = buildEntryBlock(content);

    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buildFileHeader(display) + entry, 'utf-8');
    } else {
        fs.appendFileSync(filePath, entry, 'utf-8');
    }

    return { filePath, display, filename };
}

// ─── Stdin Reader ───────────────────────────────────────────────────────────

function readInput(): Promise<JournalInput> {
    return new Promise((resolve, reject) => {
        let data = '';

        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data) as JournalInput);
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
    const { content } = input.params;

    if (!content || !content.trim()) {
        console.log(JSON.stringify({ success: false, error: 'Journal entry content is empty.' } as JournalResult));
        return;
    }

    try {
        const { filePath, filename } = writeJournalEntry(content.trim());
        const vaultPath = filePath.replace(VAULT_PATH, '').replace(/^\//, '');

        const result: JournalResult = { success: true, filePath, vaultPath, filename };
        console.log(JSON.stringify(result));
    } catch (err) {
        const result: JournalResult = {
            success: false,
            error: `Failed to write journal entry: ${(err as Error).message}`,
        };
        console.log(JSON.stringify(result));
    }
}

main().catch(err => {
    console.log(JSON.stringify({ success: false, error: `Unexpected error: ${err.message}` } as JournalResult));
    process.exit(1);
});
