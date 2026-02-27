/**
 * Get Vault URL Script
 *
 * Builds a full Obsidian vault URL from a vault-relative path.
 * Receives { params: { vault_path }, secrets: { NOTES_URL } } via stdin.
 * Writes JSON result to stdout.
 */

interface VaultUrlInput {
    params: {
        vault_path: string;
    };
    secrets?: {
        NOTES_URL?: string;
    };
}

interface VaultUrlResult {
    success: boolean;
    url?: string;
    message?: string;
    error?: string;
}

function readInput(): Promise<VaultUrlInput> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data) as VaultUrlInput);
            } catch (err) {
                reject(new Error(`Failed to parse stdin: ${(err as Error).message}`));
            }
        });
        process.stdin.on('error', reject);
    });
}

async function main() {
    const input = await readInput();
    const { params, secrets } = input;

    let notesUrl = 'https://notes.im7try1ng.com';
    if (secrets?.NOTES_URL) {
        notesUrl = secrets.NOTES_URL.replace(/\/$/, '');
    }

    let vaultPath = (params.vault_path || '').trim();
    // Strip leading "vault/" prefix — vault paths may or may not include it
    vaultPath = vaultPath.replace(/^vault\//, '').replace(/^\//, '');

    if (!vaultPath) {
        const result: VaultUrlResult = { success: false, error: 'vault_path is empty' };
        console.log(JSON.stringify(result));
        return;
    }

    const url = `${notesUrl}/${vaultPath}`;
    const result: VaultUrlResult = {
        success: true,
        url,
        message: url,
    };
    console.log(JSON.stringify(result));
}

main().catch(err => {
    const result: VaultUrlResult = { success: false, error: `Unexpected error: ${err.message}` };
    console.log(JSON.stringify(result));
    process.exit(1);
});
