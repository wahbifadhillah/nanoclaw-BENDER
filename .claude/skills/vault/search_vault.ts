/**
 * Search Vault Script
 *
 * Searches for files or content within the Obsidian vault.
 * Receives { params: { query, path?, mode? } } via stdin.
 * Writes JSON result to stdout.
 *
 * mode: 'content'  (default) — search file bodies for query string
 *       'filename'            — match file paths against query string
 *
 * Security: search path is validated to stay within VAULT_PATH (no traversal).
 */

import fs from 'fs';
import path from 'path';

// ─── Config ─────────────────────────────────────────────────────────────────

const VAULT_PATH = path.resolve(process.env.NANOCLAW_VAULT_PATH || '/opt/vault');
const MAX_RESULTS = 20;         // max files returned
const MAX_MATCHES_PER_FILE = 5; // max matching lines per file

// ─── Types ───────────────────────────────────────────────────────────────────

interface SearchVaultInput {
  params: {
    query: string;
    path?: string;                       // vault-relative subdirectory
    mode?: 'content' | 'filename';
  };
}

interface SearchMatch {
  file: string;       // vault-relative path
  matches: string[];  // matching lines (content mode) or empty (filename mode)
}

interface SearchVaultResult {
  success: boolean;
  results?: SearchMatch[];
  totalFiles?: number;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readInput(): Promise<SearchVaultInput> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data) as SearchVaultInput); }
      catch (err) { reject(new Error(`Failed to parse stdin: ${(err as Error).message}`)); }
    });
    process.stdin.on('error', reject);
  });
}

function walkMdFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMdFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const input = await readInput();
  const { query, path: searchPath, mode = 'content' } = input.params;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    console.log(JSON.stringify({
      success: false,
      error: 'query must be a non-empty string of at least 2 characters.',
    } as SearchVaultResult));
    return;
  }

  // Resolve and validate the search root
  let searchRoot = VAULT_PATH;
  if (searchPath) {
    const stripped = searchPath.replace(/^vault\//, '').replace(/^\//, '');
    const resolved = path.resolve(VAULT_PATH, stripped);
    if (!resolved.startsWith(VAULT_PATH + path.sep) && resolved !== VAULT_PATH) {
      console.log(JSON.stringify({
        success: false,
        error: `Path escapes vault root: "${searchPath}"`,
      } as SearchVaultResult));
      return;
    }
    searchRoot = resolved;
  }

  const allFiles = walkMdFiles(searchRoot);
  const lowerQuery = query.toLowerCase();
  const results: SearchMatch[] = [];

  if (mode === 'filename') {
    for (const file of allFiles) {
      const relPath = file.slice(VAULT_PATH.length + 1);
      if (relPath.toLowerCase().includes(lowerQuery)) {
        results.push({ file: relPath, matches: [] });
        if (results.length >= MAX_RESULTS) break;
      }
    }
  } else {
    // Content search
    for (const file of allFiles) {
      const relPath = file.slice(VAULT_PATH.length + 1);
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        const matchingLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            matchingLines.push(`L${i + 1}: ${lines[i].trim()}`);
            if (matchingLines.length >= MAX_MATCHES_PER_FILE) break;
          }
        }
        if (matchingLines.length > 0) {
          results.push({ file: relPath, matches: matchingLines });
          if (results.length >= MAX_RESULTS) break;
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  console.log(JSON.stringify({
    success: true,
    results,
    totalFiles: allFiles.length,
  } as SearchVaultResult));
}

main().catch(err => {
  console.log(JSON.stringify({
    success: false,
    error: `Unexpected error: ${(err as Error).message}`,
  } as SearchVaultResult));
  process.exit(1);
});
