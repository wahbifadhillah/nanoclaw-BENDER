/**
 * Dump Skill - MCP Tool Definitions (Agent/Container Side)
 *
 * Defines the dump_tasks tool for saving tagged todo lists to the vault.
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
const RESULTS_DIR = path.join(IPC_DIR, 'dump_results');

// Ensure results dir exists
fs.mkdirSync(RESULTS_DIR, { recursive: true });

/**
 * Send a task to the host via IPC and wait for result.
 */
async function sendTask(type: string, params: object): Promise<unknown> {
  const taskId = `dump-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

  throw new Error('Dump task timed out after 15s');
}

/**
 * Parse raw user input from a /dump command.
 *
 * Handles:
 *   /dump #tag
 *   - todo item
 *   - [ ] already formatted
 *
 * Returns extracted tags and normalized task lines.
 */
function parseDumpInput(raw: string): { tags: string[]; tasks: string[] } {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // Extract all #tags from any line (typically the first line)
  const tagPattern = /#([a-zA-Z0-9_-]+)/g;
  const tags: string[] = [];
  for (const line of lines) {
    let match;
    while ((match = tagPattern.exec(line)) !== null) {
      tags.push(match[1]);
    }
  }

  // Extract task lines (lines starting with `- `)
  const tasks: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ')) {
      // Normalize: `- text` → `- [ ] text`, `- [ ] text` → keep
      if (line.startsWith('- [ ] ') || line.startsWith('- [x] ')) {
        tasks.push(line);
      } else {
        tasks.push(`- [ ] ${line.slice(2)}`);
      }
    }
  }

  return { tags, tasks };
}

/**
 * Validate a tag name.
 * Only letters, numbers, hyphens, underscores allowed.
 */
function validateTag(tag: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(tag);
}

export const dump_tasks = tool({
  name: 'dump_tasks',
  description: [
    'Save todo tasks to tagged markdown files in the Obsidian vault.',
    'Called when user sends +dump (from Telegram) or /dump (CLI) with #tag and a list of tasks.',
    'Automatically converts `- item` to `- [ ] item` checkbox format.',
    'Appends to existing tag files with timestamp, never overwrites.',
  ].join(' '),
  input_schema: z.object({
    raw_input: z.string().describe(
      'The full raw /dump message from the user, including #tags and task lines'
    ),
  }),
  async execute({ raw_input }) {
    const { tags, tasks } = parseDumpInput(raw_input);

    // Validate: tags present
    if (tags.length === 0) {
      return {
        success: false,
        error: '❌ No tags found. Use #tagname in your /dump message.',
      };
    }

    // Validate: tag format
    const invalidTags = tags.filter(t => !validateTag(t));
    if (invalidTags.length > 0) {
      return {
        success: false,
        error: `❌ Only letters, numbers, hyphens and underscores allowed to create /dump. Invalid: ${invalidTags.map(t => `#${t}`).join(', ')}`,
      };
    }

    // Validate: tasks present
    if (tasks.length === 0) {
      return {
        success: false,
        error: '❌ Task/todo is missing. Add items starting with `- ` or `- [ ]`.',
      };
    }

    // Send to host
    const result = await sendTask('dump', { tags, tasks });
    return result;
  },
});
