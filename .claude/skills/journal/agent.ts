/**
 * Journal Skill - MCP Tool Definitions (Agent/Container Side)
 *
 * Defines the save_journal tool for appending entries to the daily journal file.
 * Communicates with host via IPC file system bridge.
 *
 * Note: This file is compiled in the container, not on the host.
 */

// @ts-ignore - SDK available in container environment only
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// IPC directories (inside container)
const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'journal_results');

// Ensure results dir exists
fs.mkdirSync(RESULTS_DIR, { recursive: true });

/**
 * Send a task to the host via IPC and wait for result.
 */
async function sendTask(type: string, params: object): Promise<unknown> {
    const taskId = `journal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const taskFile = path.join(TASKS_DIR, `${taskId}.json`);
    const resultFile = path.join(RESULTS_DIR, `${taskId}.json`);

    fs.writeFileSync(taskFile, JSON.stringify({ type, params, taskId }));

    // Poll for result (max 15s)
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (fs.existsSync(resultFile)) {
            const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
            fs.unlinkSync(resultFile);
            return result;
        }
    }

    throw new Error('Journal task timed out after 15s');
}

/**
 * Parse raw user input from a /journal command.
 *
 * Strips the `/journal` trigger line and returns the remaining content.
 *
 * Example:
 *   /journal
 *   Lorem ipsum...
 *
 * Returns: { content: "Lorem ipsum..." }
 */
function parseJournalInput(raw: string): { content: string } {
    const lines = raw.split('\n');

    // Drop the first line if it's the /journal or +journal trigger
    const firstLine = lines[0].trim().toLowerCase();
    const bodyLines = (firstLine.startsWith('/journal') || firstLine.startsWith('+journal'))
        ? lines.slice(1)
        : lines;

    const content = bodyLines.join('\n').trim();

    return { content };
}

export const save_journal = tool({
    name: 'save_journal',
    description: [
        'Append a journal entry to the daily markdown file in the Obsidian vault.',
        'Called when user sends +journal (from Telegram) or /journal (CLI) followed by their entry text.',
        'Entries are timestamped and appended — never overwritten.',
        'One file per day at /opt/vault/journal/{DD/MM/YYYY}-journal.md.',
    ].join(' '),
    input_schema: z.object({
        raw_input: z.string().describe(
            'The full raw /journal message from the user, including the trigger line and entry content'
        ),
    }),
    async execute({ raw_input }) {
        const { content } = parseJournalInput(raw_input);

        // Validate: content must not be empty
        if (!content) {
            return {
                success: false,
                error: '❌ Journal entry is empty. Add some text after /journal.',
            };
        }

        // Send to host
        const result = await sendTask('journal', { content });
        return result;
    },
});