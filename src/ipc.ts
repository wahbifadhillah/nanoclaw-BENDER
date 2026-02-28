import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { sendPoolMessage } from './channels/telegram.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  /** Called when a pool message is successfully sent for a chatJid (Telegram+pool path). */
  onPoolMessageSent?: (chatJid: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (data.sender && data.chatJid.startsWith('tg:')) {
                    const result = await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                    if (result === 'unknown_agent') {
                      await deps.sendMessage(
                        data.chatJid,
                        `Agent '${data.sender}' has no assigned bot. Add agent definition, then assign the task again.`,
                      );
                    } else {
                      deps.onPoolMessageSent?.(data.chatJid);
                    }
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup, sender: data.sender },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              try { fs.unlinkSync(filePath); } catch (unlinkErr: unknown) {
                // ENOENT = already deleted (e.g., stale duplicate process race) — ignore
                if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
              } catch (renameErr: unknown) {
                if ((renameErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                  logger.error({ file, sourceGroup, err: renameErr }, 'Error moving IPC message to errors dir');
                }
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              try { fs.unlinkSync(filePath); } catch (unlinkErr: unknown) {
                if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
              } catch (renameErr: unknown) {
                if ((renameErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                  logger.error({ file, sourceGroup, err: renameErr }, 'Error moving IPC task to errors dir');
                }
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For journal / dump skill tasks
    params?: { content?: string; tags?: string[]; tasks?: string[]; vault_path?: string; url?: string; mode?: string; query?: string };
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'journal': {
      if (!data.taskId || !data.params?.content) {
        logger.warn({ data }, 'Invalid journal task: missing taskId or content');
        break;
      }
      const { taskId: journalTaskId, params: journalParams } = data as {
        taskId: string;
        params: { content: string };
      };
      const journalSkillDir = path.join(process.cwd(), '.claude', 'skills', 'journal');
      const journalScript = path.join(journalSkillDir, 'journal.ts');
      // journal.ts only does file I/O — no URL secrets needed (chaining handled by MCP layer)
      const journalSecrets = {};
      const journalResultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'journal_results');
      fs.mkdirSync(journalResultDir, { recursive: true });
      const journalResultFile = path.join(journalResultDir, `${journalTaskId}.json`);

      logger.info({ taskId: journalTaskId, sourceGroup }, 'Processing journal task');

      const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const journalProc = spawn(
        tsxBin,
        [journalScript],
        {
          cwd: journalSkillDir,
          env: { NODE_ENV: process.env.NODE_ENV || 'production', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      journalProc.stdin.write(JSON.stringify({ params: journalParams, secrets: journalSecrets }));
      journalProc.stdin.end();

      let journalOut = '';
      let journalErr = '';
      journalProc.stdout.on('data', (d: Buffer) => { journalOut += d.toString(); });
      journalProc.stderr.on('data', (d: Buffer) => { journalErr += d.toString(); });

      await new Promise<void>((resolve) => {
        journalProc.on('close', (code) => {
          if (code !== 0) {
            logger.error({ code, stderr: journalErr }, 'journal script failed');
            fs.writeFileSync(journalResultFile, JSON.stringify({
              success: false,
              error: journalErr || `Script exited with code ${code}`,
            }));
          } else {
            try {
              JSON.parse(journalOut.trim());
              fs.writeFileSync(journalResultFile, journalOut.trim());
            } catch {
              fs.writeFileSync(journalResultFile, JSON.stringify({
                success: false,
                error: `Invalid script output: ${journalOut}`,
              }));
            }
          }
          logger.info({ taskId: journalTaskId, sourceGroup }, 'Journal task complete');
          resolve();
        });
      });
      break;
    }

    case 'dump': {
      if (!data.taskId || !data.params?.tags || !data.params?.tasks) {
        logger.warn({ data }, 'Invalid dump task: missing taskId, tags, or tasks');
        break;
      }
      const { taskId: dumpTaskId, params: dumpParams } = data as {
        taskId: string;
        params: { tags: string[]; tasks: string[] };
      };
      const dumpSkillDir = path.join(process.cwd(), '.claude', 'skills', 'dump');
      const dumpScript = path.join(dumpSkillDir, 'dump.ts');
      // dump.ts only does file I/O — no URL secrets needed (chaining handled by MCP layer)
      const dumpSecrets = {};
      const dumpResultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'dump_results');
      fs.mkdirSync(dumpResultDir, { recursive: true });
      const dumpResultFile = path.join(dumpResultDir, `${dumpTaskId}.json`);

      logger.info({ taskId: dumpTaskId, sourceGroup, tags: dumpParams.tags }, 'Processing dump task');

      const tsxBinDump = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const dumpProc = spawn(
        tsxBinDump,
        [dumpScript],
        {
          cwd: dumpSkillDir,
          env: { NODE_ENV: process.env.NODE_ENV || 'production', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      dumpProc.stdin.write(JSON.stringify({ params: dumpParams, secrets: dumpSecrets }));
      dumpProc.stdin.end();

      let dumpOut = '';
      let dumpErr = '';
      dumpProc.stdout.on('data', (d: Buffer) => { dumpOut += d.toString(); });
      dumpProc.stderr.on('data', (d: Buffer) => { dumpErr += d.toString(); });

      await new Promise<void>((resolve) => {
        dumpProc.on('close', (code) => {
          if (code !== 0) {
            logger.error({ code, stderr: dumpErr }, 'dump script failed');
            fs.writeFileSync(dumpResultFile, JSON.stringify({
              success: false,
              error: dumpErr || `Script exited with code ${code}`,
            }));
          } else {
            try {
              JSON.parse(dumpOut.trim());
              fs.writeFileSync(dumpResultFile, dumpOut.trim());
            } catch {
              fs.writeFileSync(dumpResultFile, JSON.stringify({
                success: false,
                error: `Invalid script output: ${dumpOut}`,
              }));
            }
          }
          logger.info({ taskId: dumpTaskId, sourceGroup }, 'Dump task complete');
          resolve();
        });
      });
      break;
    }

    case 'write_vault_file': {
      if (!data.taskId || !data.params?.vault_path || data.params?.content === undefined || !data.params?.mode) {
        logger.warn({ data }, 'Invalid write_vault_file task: missing taskId, vault_path, content, or mode');
        break;
      }
      const { taskId: wvfTaskId, params: wvfParams } = data as {
        taskId: string;
        params: { vault_path: string; content: string; mode: string };
      };
      const wvfSkillDir = path.join(process.cwd(), '.claude', 'skills', 'vault');
      const wvfScript = path.join(wvfSkillDir, 'write_vault_file.ts');
      // Pure filesystem — no secrets needed
      const wvfResultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'write_vault_file_results');
      fs.mkdirSync(wvfResultDir, { recursive: true });
      const wvfResultFile = path.join(wvfResultDir, `${wvfTaskId}.json`);

      logger.info({ taskId: wvfTaskId, sourceGroup, vault_path: wvfParams.vault_path, mode: wvfParams.mode }, 'Processing write_vault_file task');

      const tsxBinWvf = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const wvfProc = spawn(
        tsxBinWvf,
        [wvfScript],
        {
          cwd: wvfSkillDir,
          env: { NODE_ENV: process.env.NODE_ENV || 'production', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      wvfProc.stdin.write(JSON.stringify({ params: wvfParams }));
      wvfProc.stdin.end();

      let wvfOut = '';
      let wvfErr = '';
      wvfProc.stdout.on('data', (d: Buffer) => { wvfOut += d.toString(); });
      wvfProc.stderr.on('data', (d: Buffer) => { wvfErr += d.toString(); });

      await new Promise<void>((resolve) => {
        wvfProc.on('close', (code) => {
          if (code !== 0) {
            logger.error({ code, stderr: wvfErr }, 'write_vault_file script failed');
            fs.writeFileSync(wvfResultFile, JSON.stringify({
              success: false,
              error: wvfErr || `Script exited with code ${code}`,
            }));
          } else {
            try {
              JSON.parse(wvfOut.trim());
              fs.writeFileSync(wvfResultFile, wvfOut.trim());
            } catch {
              fs.writeFileSync(wvfResultFile, JSON.stringify({
                success: false,
                error: `Invalid script output: ${wvfOut}`,
              }));
            }
          }
          logger.info({ taskId: wvfTaskId, sourceGroup }, 'write_vault_file task complete');
          resolve();
        });
      });
      break;
    }

    case 'vault_url': {
      if (!data.taskId || !data.params?.vault_path) {
        logger.warn({ data }, 'Invalid vault_url task: missing taskId or vault_path');
        break;
      }
      const { taskId: vaultUrlTaskId, params: vaultUrlParams } = data as {
        taskId: string;
        params: { vault_path: string };
      };
      const vaultUrlSkillDir = path.join(process.cwd(), '.claude', 'skills', 'vault');
      const vaultUrlScript = path.join(vaultUrlSkillDir, 'get_vault_url.ts');
      const vaultUrlSecrets = readEnvFile(['NOTES_URL']);
      const vaultUrlResultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'vault_url_results');
      fs.mkdirSync(vaultUrlResultDir, { recursive: true });
      const vaultUrlResultFile = path.join(vaultUrlResultDir, `${vaultUrlTaskId}.json`);

      logger.info({ taskId: vaultUrlTaskId, sourceGroup, vault_path: vaultUrlParams.vault_path }, 'Processing vault_url task');

      const tsxBinVaultUrl = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const vaultUrlProc = spawn(
        tsxBinVaultUrl,
        [vaultUrlScript],
        {
          cwd: vaultUrlSkillDir,
          env: { NODE_ENV: process.env.NODE_ENV || 'production', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      vaultUrlProc.stdin.write(JSON.stringify({ params: vaultUrlParams, secrets: vaultUrlSecrets }));
      vaultUrlProc.stdin.end();

      let vaultUrlOut = '';
      let vaultUrlErr = '';
      vaultUrlProc.stdout.on('data', (d: Buffer) => { vaultUrlOut += d.toString(); });
      vaultUrlProc.stderr.on('data', (d: Buffer) => { vaultUrlErr += d.toString(); });

      await new Promise<void>((resolve) => {
        vaultUrlProc.on('close', (code) => {
          if (code !== 0) {
            logger.error({ code, stderr: vaultUrlErr }, 'get_vault_url script failed');
            fs.writeFileSync(vaultUrlResultFile, JSON.stringify({
              success: false,
              error: vaultUrlErr || `Script exited with code ${code}`,
            }));
          } else {
            try {
              JSON.parse(vaultUrlOut.trim());
              fs.writeFileSync(vaultUrlResultFile, vaultUrlOut.trim());
            } catch {
              fs.writeFileSync(vaultUrlResultFile, JSON.stringify({
                success: false,
                error: `Invalid script output: ${vaultUrlOut}`,
              }));
            }
          }
          logger.info({ taskId: vaultUrlTaskId, sourceGroup }, 'vault_url task complete');
          resolve();
        });
      });
      break;
    }

    case 'short_url': {
      if (!data.taskId || !data.params?.url) {
        logger.warn({ data }, 'Invalid short_url task: missing taskId or url');
        break;
      }
      const { taskId: shortUrlTaskId, params: shortUrlParams } = data as {
        taskId: string;
        params: { url: string };
      };
      const shortUrlSkillDir = path.join(process.cwd(), '.claude', 'skills', 'vault');
      const shortUrlScript = path.join(shortUrlSkillDir, 'get_short_url.ts');
      const shortUrlSecrets = readEnvFile(['SHLINK_URL', 'SHLINK_API_KEY', 'SHLINK']);
      const shortUrlResultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'short_url_results');
      fs.mkdirSync(shortUrlResultDir, { recursive: true });
      const shortUrlResultFile = path.join(shortUrlResultDir, `${shortUrlTaskId}.json`);

      logger.info({ taskId: shortUrlTaskId, sourceGroup, url: shortUrlParams.url }, 'Processing short_url task');

      const tsxBinShortUrl = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const shortUrlProc = spawn(
        tsxBinShortUrl,
        [shortUrlScript],
        {
          cwd: shortUrlSkillDir,
          env: { NODE_ENV: process.env.NODE_ENV || 'production', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      shortUrlProc.stdin.write(JSON.stringify({ params: shortUrlParams, secrets: shortUrlSecrets }));
      shortUrlProc.stdin.end();

      let shortUrlOut = '';
      let shortUrlErr = '';
      shortUrlProc.stdout.on('data', (d: Buffer) => { shortUrlOut += d.toString(); });
      shortUrlProc.stderr.on('data', (d: Buffer) => { shortUrlErr += d.toString(); });

      await new Promise<void>((resolve) => {
        shortUrlProc.on('close', (code) => {
          if (code !== 0) {
            logger.error({ code, stderr: shortUrlErr }, 'get_short_url script failed');
            fs.writeFileSync(shortUrlResultFile, JSON.stringify({
              success: false,
              error: shortUrlErr || `Script exited with code ${code}`,
            }));
          } else {
            try {
              JSON.parse(shortUrlOut.trim());
              fs.writeFileSync(shortUrlResultFile, shortUrlOut.trim());
            } catch {
              fs.writeFileSync(shortUrlResultFile, JSON.stringify({
                success: false,
                error: `Invalid script output: ${shortUrlOut}`,
              }));
            }
          }
          logger.info({ taskId: shortUrlTaskId, sourceGroup }, 'short_url task complete');
          resolve();
        });
      });
      break;
    }

    case 'search_vault': {
      if (!data.taskId || !data.params?.query) {
        logger.warn({ data }, 'Invalid search_vault task: missing taskId or query');
        break;
      }
      const { taskId: svTaskId, params: svParams } = data as {
        taskId: string;
        params: { query: string; path?: string; mode?: string };
      };
      const svSkillDir = path.join(process.cwd(), '.claude', 'skills', 'vault');
      const svScript = path.join(svSkillDir, 'search_vault.ts');
      const svResultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'search_vault_results');
      fs.mkdirSync(svResultDir, { recursive: true });
      const svResultFile = path.join(svResultDir, `${svTaskId}.json`);

      logger.info({ taskId: svTaskId, sourceGroup, query: svParams.query }, 'Processing search_vault task');

      const tsxBinSv = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const svProc = spawn(
        tsxBinSv,
        [svScript],
        {
          cwd: svSkillDir,
          env: {
            NODE_ENV: process.env.NODE_ENV || 'production',
            ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
            ...(process.env.NANOCLAW_VAULT_PATH ? { NANOCLAW_VAULT_PATH: process.env.NANOCLAW_VAULT_PATH } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      svProc.stdin.write(JSON.stringify({ params: svParams }));
      svProc.stdin.end();

      let svOut = '';
      let svErr = '';
      svProc.stdout.on('data', (d: Buffer) => { svOut += d.toString(); });
      svProc.stderr.on('data', (d: Buffer) => { svErr += d.toString(); });

      await new Promise<void>((resolve) => {
        svProc.on('close', (code) => {
          if (code !== 0) {
            logger.error({ code, stderr: svErr }, 'search_vault script failed');
            fs.writeFileSync(svResultFile, JSON.stringify({
              success: false,
              error: svErr || `Script exited with code ${code}`,
            }));
          } else {
            try {
              JSON.parse(svOut.trim());
              fs.writeFileSync(svResultFile, svOut.trim());
            } catch {
              fs.writeFileSync(svResultFile, JSON.stringify({
                success: false,
                error: `Invalid script output: ${svOut}`,
              }));
            }
          }
          logger.info({ taskId: svTaskId, sourceGroup }, 'search_vault task complete');
          resolve();
        });
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
