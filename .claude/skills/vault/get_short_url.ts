/**
 * Get Short URL Script
 *
 * Creates a short URL via the Shlink API.
 * Receives { params: { url }, secrets: { SHLINK_URL, SHLINK_API_KEY, SHLINK } } via stdin.
 * Writes JSON result to stdout.
 */

import http from 'http';
import https from 'https';

interface ShortUrlInput {
    params: {
        url: string;
    };
    secrets?: {
        SHLINK_URL?: string;
        SHLINK_API_KEY?: string;
        SHLINK?: string;
    };
}

interface ShortUrlResult {
    success: boolean;
    url?: string;
    message?: string;
    error?: string;
}

function readInput(): Promise<ShortUrlInput> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', chunk => { data += chunk; });
        process.stdin.on('end', () => {
            try {
                resolve(JSON.parse(data) as ShortUrlInput);
            } catch (err) {
                reject(new Error(`Failed to parse stdin: ${(err as Error).message}`));
            }
        });
        process.stdin.on('error', reject);
    });
}

function createShortUrl(
    longUrl: string,
    shlinkInternal: string,
    shlinkPublicUrl: string,
    apiKey: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ longUrl, findIfExists: true });
        const [shlinkHost, shlinkPort] = shlinkInternal.split(':');
        const port = parseInt(shlinkPort || '8080', 10);

        const options = {
            hostname: shlinkHost,
            port,
            path: '/rest/v3/short-urls',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': apiKey,
                'Content-Length': Buffer.byteLength(body),
            },
        };

        // Use http for internal (non-443), https for external
        const transport = port === 443 ? https : http;

        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.shortCode) {
                        resolve(`${shlinkPublicUrl.replace(/\/$/, '')}/${parsed.shortCode}`);
                    } else if (parsed.shortUrl) {
                        resolve(parsed.shortUrl);
                    } else {
                        reject(new Error(`Shlink response missing shortCode: ${data}`));
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse Shlink response: ${data}`));
                }
            });
        });

        req.on('error', err => reject(err));
        req.write(body);
        req.end();
    });
}

async function main() {
    const input = await readInput();
    const { params, secrets } = input;

    let shlinkPublicUrl = 'https://s.im7try1ng.com';
    let shlinkInternal = 'localhost:8080';
    let apiKey = '';

    if (secrets?.SHLINK_URL) shlinkPublicUrl = secrets.SHLINK_URL.replace(/\/$/, '');
    if (secrets?.SHLINK) shlinkInternal = secrets.SHLINK;
    if (secrets?.SHLINK_API_KEY) apiKey = secrets.SHLINK_API_KEY;

    const longUrl = (params.url || '').trim();

    if (!longUrl) {
        const result: ShortUrlResult = { success: false, error: 'url is empty' };
        console.log(JSON.stringify(result));
        return;
    }

    if (!apiKey) {
        const result: ShortUrlResult = { success: false, error: 'SHLINK_API_KEY not configured' };
        console.log(JSON.stringify(result));
        return;
    }

    try {
        const shortUrl = await createShortUrl(longUrl, shlinkInternal, shlinkPublicUrl, apiKey);
        const result: ShortUrlResult = { success: true, url: shortUrl, message: shortUrl };
        console.log(JSON.stringify(result));
    } catch (err) {
        const result: ShortUrlResult = {
            success: false,
            error: `Shlink error: ${(err as Error).message}`,
        };
        console.log(JSON.stringify(result));
    }
}

main().catch(err => {
    const result: ShortUrlResult = { success: false, error: `Unexpected error: ${err.message}` };
    console.log(JSON.stringify(result));
    process.exit(1);
});
