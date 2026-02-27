/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

/**
 * Write an IPC task and poll for its result.
 * Shared helper for chaining atomic tools from within MCP handlers.
 * Returns the parsed result or null on timeout/error.
 */
async function ipcCall(
  type: string,
  taskId: string,
  params: object,
  resultsDirName: string,
): Promise<Record<string, unknown> | null> {
  const resultsDir = path.join(IPC_DIR, resultsDirName);
  const resultFile = path.join(resultsDir, `${taskId}.json`);

  fs.mkdirSync(resultsDir, { recursive: true });
  writeIpcFile(TASKS_DIR, { type, taskId, params });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (fs.existsSync(resultFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        fs.unlinkSync(resultFile);
        return result;
      } catch {
        return null;
      }
    }
  }
  return null; // timeout
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'save_journal',
  [
    'Append a journal entry to the daily markdown file in the Obsidian vault.',
    'Call this when the user sends +journal followed by their entry text.',
    'Entries are timestamped and appended — never overwritten.',
    'One file per day at /opt/vault/journal/DD-MM-YYYY-journal.md.',
    'Returns a short URL to the journal file.',
  ].join(' '),
  {
    raw_input: z.string().describe(
      'The full raw +journal message from the user, including the trigger line and entry content',
    ),
  },
  async (args) => {
    // Parse content: strip the +journal / /journal trigger line
    const lines = args.raw_input.split('\n');
    const firstLine = lines[0].trim().toLowerCase();
    const bodyLines =
      firstLine.startsWith('/journal') || firstLine.startsWith('+journal')
        ? lines.slice(1)
        : lines;
    const content = bodyLines.join('\n').trim();

    if (!content) {
      return {
        content: [{ type: 'text' as const, text: '❌ Journal entry is empty. Add some text after +journal.' }],
        isError: true,
      };
    }

    // Step 1: Write journal entry (file I/O only)
    const taskId = `journal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const journalResult = await ipcCall('journal', taskId, { content }, 'journal_results');

    if (!journalResult) {
      return {
        content: [{ type: 'text' as const, text: '❌ Journal task timed out. Host may not be processing journal tasks.' }],
        isError: true,
      };
    }

    if (!journalResult.success) {
      return {
        content: [{ type: 'text' as const, text: `❌ ${journalResult.error || 'Journal write failed.'}` }],
        isError: true,
      };
    }

    const filename = journalResult.filename as string;
    const vaultPath = journalResult.vaultPath as string | undefined;

    // Step 2: Chain — get_vault_url → get_short_url (journal always gets a URL)
    let urlLine = '';
    if (vaultPath) {
      const vaultUrlId = `vault-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const vaultUrlResult = await ipcCall('vault_url', vaultUrlId, { vault_path: vaultPath }, 'vault_url_results');

      if (vaultUrlResult?.success && vaultUrlResult.url) {
        const shortUrlId = `short-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const shortUrlResult = await ipcCall('short_url', shortUrlId, { url: vaultUrlResult.url }, 'short_url_results');
        urlLine = `\n${(shortUrlResult?.url as string) || (vaultUrlResult.url as string)}`;
      }
    }

    // Step 3: Build response message
    const treeLines = [
      '```',
      '├── journal/',
      `└── ${filename}`,
      '```',
    ].join('\n');

    const text = `✅ Saved journal entry to:\n${treeLines}${urlLine}`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'dump_tasks',
  [
    'Save todo tasks to tagged markdown files in the Obsidian vault.',
    'Call this when the user sends +dump with #tag and a list of tasks.',
    'Automatically converts `- item` to `- [ ] item` checkbox format.',
    'Appends to existing tag files with timestamp, never overwrites.',
    'For single-tag dumps, returns a short URL to the tag file.',
  ].join(' '),
  {
    raw_input: z.string().describe(
      'The full raw +dump message from the user, including #tags and task lines',
    ),
  },
  async (args) => {
    // Parse tags from any line
    const lines = args.raw_input.split('\n').map((l: string) => l.trim()).filter(Boolean);
    const tagPattern = /#([a-zA-Z0-9_-]+)/g;
    const tags: string[] = [];
    for (const line of lines) {
      let match;
      while ((match = tagPattern.exec(line)) !== null) {
        tags.push(match[1]);
      }
    }

    // Parse task lines (lines starting with `- `)
    const tasks: string[] = [];
    for (const line of lines) {
      if (line.startsWith('- ')) {
        if (line.startsWith('- [ ] ') || line.startsWith('- [x] ')) {
          tasks.push(line);
        } else {
          tasks.push(`- [ ] ${line.slice(2)}`);
        }
      }
    }

    // Validate
    if (tags.length === 0) {
      return {
        content: [{ type: 'text' as const, text: '❌ No tags found. Use #tagname in your +dump message.' }],
        isError: true,
      };
    }
    const invalidTags = tags.filter(t => !/^[a-zA-Z0-9_-]+$/.test(t));
    if (invalidTags.length > 0) {
      return {
        content: [{ type: 'text' as const, text: `❌ Invalid tag names: ${invalidTags.map(t => `#${t}`).join(', ')}. Only letters, numbers, hyphens, underscores allowed.` }],
        isError: true,
      };
    }
    if (tasks.length === 0) {
      return {
        content: [{ type: 'text' as const, text: '❌ No task items found. Add items starting with `- ` or `- [ ]`.' }],
        isError: true,
      };
    }

    // Step 1: Write dump entries (file I/O only)
    const taskId = `dump-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dumpResult = await ipcCall('dump', taskId, { tags, tasks }, 'dump_results');

    if (!dumpResult) {
      return {
        content: [{ type: 'text' as const, text: '❌ Dump task timed out. Host may not be processing dump tasks.' }],
        isError: true,
      };
    }

    if (!dumpResult.success) {
      return {
        content: [{ type: 'text' as const, text: `❌ ${dumpResult.error || 'Dump write failed.'}` }],
        isError: true,
      };
    }

    const results = dumpResult.results as Array<{ tag: string; taskCount: number; vaultPath: string }>;

    // Step 2: Chain — get_vault_url → get_short_url (single-tag only)
    let urlLine = '';
    if (results.length === 1 && results[0].vaultPath) {
      const vaultUrlId = `vault-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const vaultUrlResult = await ipcCall('vault_url', vaultUrlId, { vault_path: results[0].vaultPath }, 'vault_url_results');

      if (vaultUrlResult?.success && vaultUrlResult.url) {
        const shortUrlId = `short-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const shortUrlResult = await ipcCall('short_url', shortUrlId, { url: vaultUrlResult.url }, 'short_url_results');
        urlLine = `\n${(shortUrlResult?.url as string) || (vaultUrlResult.url as string)}`;
      }
    }

    // Step 3: Build response message
    let text: string;
    if (results.length === 1) {
      const r = results[0];
      const entryWord = r.taskCount === 1 ? 'entry' : 'entries';
      const treeLines = ['```', '├── dumps/', `└── ${r.tag}`, '```'].join('\n');
      text = `✅ Saved ${r.taskCount} ${entryWord} to:\n${treeLines}${urlLine}`;
    } else {
      const dumpWord = results.length === 1 ? 'dump' : 'dumps';
      const treeLines = [
        '```',
        '├── dumps/',
        ...results.map((r, i) => {
          const prefix = i === results.length - 1 ? '└── ' : '├── ';
          const entryWord = r.taskCount === 1 ? 'entry' : 'entries';
          return `${prefix}${r.tag} --${r.taskCount} ${entryWord}`;
        }),
        '```',
      ].join('\n');
      text = `✅ Saved ${results.length} ${dumpWord} to:\n${treeLines}`;
    }

    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'write_vault_file',
  [
    'Write or append content to a file in the Obsidian vault.',
    'Use mode="write" to create or overwrite a file entirely.',
    'Use mode="append" to add content to the end of a file (creates it if missing).',
    'vault_path is relative to the vault root, e.g. "research/ai-notes.md" or "projects/tracker.md".',
    'You decide the content format — headers, timestamps, front matter, Markdown structure.',
    'Returns the vaultPath so you can optionally chain get_vault_url → get_short_url for a link.',
    'Only .md files are supported. Paths outside the vault root are rejected.',
  ].join(' '),
  {
    vault_path: z.string().describe(
      'Vault-relative path to the file, e.g. "research/ai-notes.md". Parent directories are created automatically.',
    ),
    content: z.string().describe(
      'The text content to write or append. You control the format — include headers, timestamps, front matter as needed.',
    ),
    mode: z.enum(['write', 'append']).default('append').describe(
      '"write" creates or overwrites the file entirely. "append" adds to the end and creates the file if missing.',
    ),
  },
  async (args) => {
    const taskId = `write-vault-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await ipcCall(
      'write_vault_file',
      taskId,
      { vault_path: args.vault_path, content: args.content, mode: args.mode },
      'write_vault_file_results',
    );

    if (!result) {
      return {
        content: [{ type: 'text' as const, text: '❌ write_vault_file timed out.' }],
        isError: true,
      };
    }

    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `❌ ${result.error || 'Write failed.'}` }],
        isError: true,
      };
    }

    // Return vaultPath so agent can chain get_vault_url → get_short_url if desired
    const text = `✅ ${args.mode === 'write' ? 'Written' : 'Appended'} to: ${result.vaultPath as string}`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'get_vault_url',
  [
    'Convert a vault-relative file path to a full browser URL for the Obsidian vault (SilverBullet).',
    'Use this to get a readable link to any vault file before optionally shortening it.',
    'Input: vault_path like "dumps/my-tag.md" or "journal/25-02-2026-journal.md".',
    'Output: the full URL, e.g. "https://notes.im7try1ng.com/dumps/my-tag.md".',
    'Chain with get_short_url to produce a short link.',
  ].join(' '),
  {
    vault_path: z.string().describe(
      'Vault-relative file path, e.g. "dumps/my-tag.md". May optionally include a leading "vault/" prefix which will be stripped.',
    ),
  },
  async (args) => {
    const taskId = `vault-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const resultsDir = path.join(IPC_DIR, 'vault_url_results');
    const resultFile = path.join(resultsDir, `${taskId}.json`);

    fs.mkdirSync(resultsDir, { recursive: true });
    writeIpcFile(TASKS_DIR, { type: 'vault_url', taskId, params: { vault_path: args.vault_path } });

    // Poll for result (max 15s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);
          const text = result.url || (result.success ? '✅ URL built.' : `❌ ${result.error}`);
          return { content: [{ type: 'text' as const, text }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: '❌ Failed to read vault URL result.' }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: '❌ get_vault_url timed out. Host may not be processing vault_url tasks.' }],
      isError: true,
    };
  },
);

server.tool(
  'get_short_url',
  [
    'Create a short URL via Shlink for any long URL.',
    'Use this before returning URLs to the user — short links are friendlier in Telegram.',
    'Chain after get_vault_url: get_vault_url → get_short_url → reply with short URL.',
    'Input: any full URL. Output: short URL like "https://s.im7try1ng.com/abc123".',
  ].join(' '),
  {
    url: z.string().describe(
      'The full URL to shorten, e.g. "https://notes.im7try1ng.com/dumps/my-tag.md".',
    ),
  },
  async (args) => {
    const taskId = `short-url-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const resultsDir = path.join(IPC_DIR, 'short_url_results');
    const resultFile = path.join(resultsDir, `${taskId}.json`);

    fs.mkdirSync(resultsDir, { recursive: true });
    writeIpcFile(TASKS_DIR, { type: 'short_url', taskId, params: { url: args.url } });

    // Poll for result (max 15s)
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);
          const text = result.url || (result.success ? '✅ URL shortened.' : `❌ ${result.error}`);
          return { content: [{ type: 'text' as const, text }] };
        } catch {
          return {
            content: [{ type: 'text' as const, text: '❌ Failed to read short URL result.' }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: '❌ get_short_url timed out. Host may not be processing short_url tasks.' }],
      isError: true,
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
