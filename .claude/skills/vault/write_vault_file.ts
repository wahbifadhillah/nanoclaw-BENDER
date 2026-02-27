/**
 * Write Vault File Script
 *
 * Writes or appends content to a file inside the Obsidian vault.
 * Receives { params: { vault_path, content, mode } } via stdin.
 * Writes JSON result to stdout.
 *
 * This is a primitive — it does not impose any format on the content.
 * The caller (agent) decides structure: headers, timestamps, front matter, etc.
 *
 * Security: vault_path is validated to stay within VAULT_PATH (no path traversal).
 */

import fs from 'fs';
import path from 'path';

// ─── Config ────────────────────────────────────────────────────────────────

const VAULT_PATH = path.resolve(process.env.NANOCLAW_VAULT_PATH || '/opt/vault');
const MAX_CONTENT_BYTES = 1024 * 1024; // 1 MB safety limit

// ─── Types ─────────────────────────────────────────────────────────────────

interface WriteVaultFileInput {
    params: {
        vault_path: string;           // vault-relative path, e.g. "research/ai-notes.md"
        content: string;              // text to write
        mode: 'write' | 'append';    // write=create/overwrite, append=add to end (creates if missing)
    };
}

interface WriteVaultFileResult {
    success: boolean;
    filePath?: string;   // absolute path on host
    vaultPath?: string;  // relative path — pass to get_vault_url for URL chaining
    error?: string;
}

// ─── Stdin Reader ───────────────────────────────────────────────────────────

function readInput(): Promise<WriteVaultFileInput> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data) as WriteVaultFileInput);
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
    const { vault_path, content, mode } = input.params;

    // ── Validate inputs ─────────────────────────────────────────────────────

    if (!vault_path || typeof vault_path !== 'string') {
        console.log(JSON.stringify({ success: false, error: 'vault_path is required.' } as WriteVaultFileResult));
        return;
    }

    if (typeof content !== 'string') {
        console.log(JSON.stringify({ success: false, error: 'content must be a string.' } as WriteVaultFileResult));
        return;
    }

    if (mode !== 'write' && mode !== 'append') {
        console.log(JSON.stringify({ success: false, error: 'mode must be "write" or "append".' } as WriteVaultFileResult));
        return;
    }

    if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) {
        console.log(JSON.stringify({ success: false, error: `Content exceeds 1 MB limit.` } as WriteVaultFileResult));
        return;
    }

    // ── Path security: prevent traversal outside vault ──────────────────────

    // Strip leading slash/vault prefix — callers may include either
    const stripped = vault_path.replace(/^vault\//, '').replace(/^\//, '');
    const absolutePath = path.resolve(VAULT_PATH, stripped);

    // Ensure resolved path stays inside VAULT_PATH
    if (!absolutePath.startsWith(VAULT_PATH + path.sep) && absolutePath !== VAULT_PATH) {
        console.log(JSON.stringify({
            success: false,
            error: `Path escapes vault root: "${vault_path}"`,
        } as WriteVaultFileResult));
        return;
    }

    // Must end with .md (vault files only)
    if (!absolutePath.endsWith('.md')) {
        console.log(JSON.stringify({
            success: false,
            error: 'Only .md files are supported.',
        } as WriteVaultFileResult));
        return;
    }

    // ── Write ───────────────────────────────────────────────────────────────

    try {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

        if (mode === 'write') {
            fs.writeFileSync(absolutePath, content, 'utf-8');
        } else {
            fs.appendFileSync(absolutePath, content, 'utf-8');
        }

        const vaultPath = absolutePath.replace(VAULT_PATH + path.sep, '');

        const result: WriteVaultFileResult = {
            success: true,
            filePath: absolutePath,
            vaultPath,
        };
        console.log(JSON.stringify(result));
    } catch (err) {
        console.log(JSON.stringify({
            success: false,
            error: `Write failed: ${(err as Error).message}`,
        } as WriteVaultFileResult));
    }
}

main().catch(err => {
    console.log(JSON.stringify({ success: false, error: `Unexpected error: ${err.message}` } as WriteVaultFileResult));
    process.exit(1);
});
