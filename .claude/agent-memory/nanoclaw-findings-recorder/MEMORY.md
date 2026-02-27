# NanoClaw Findings Recorder Memory

## Documented Findings Index
- `debug-container-session-subdirectory-permissions.md` (2026-02-28) — Container EACCES crash on second run due to stale SDK-created subdirectory permissions in bind-mounted `.claude/` session dir

## Recurring Patterns

### Permission Issues with Bind-Mounted Directories
- **Pattern**: Host process creates directory with `fs.mkdirSync()`, then SDK or container process creates subdirectories with default umask. On next run, different uid cannot write to stale-permission subdirs.
- **Symptom**: Container crashes silently with no stderr output, exit code 1
- **Solution**: Explicitly chmod subdirectories before container starts (`fs.chmodSync()` does NOT recurse)
- **Locations**: `.claude/` session directory, IPC directories
- **Root cause**: `fs.chmodSync()` only affects the target path, not children. Need explicit loop or recursive walk.

### State Persistence Between Container Runs
- **Pattern**: Build cache, session subdirs, and other artifacts persist across runs with stale configuration
- **Related issues**: Container build cache (mentioned in CLAUDE.md as requiring `--no-cache` + builder prune)
- **Principle**: Always reset or validate state before container spawn

## Documentation Conventions
- Findings go in `/opt/nanoclaw/roo-docs/findings/` with naming pattern: `{category}-{brief-description}.md`
- Categories: `debug`, `howto`, `config`, `pattern`, `container`, `whatsapp`, `integration`, `performance`
- Architecture docs link to findings via "See also" section or dedicated "Known Issues & Gotchas" section
- Each finding must include: Summary, Context/Problem, Root Cause, Solution, Files Changed, Caveats

## Key Files Involved in Recent Findings
- `src/container-runner.ts` — Permission handling for bind-mounted session directories (lines 128-138)
- `roo-docs/architecture/container-runner.md` — Architecture doc, has "Known Issues & Gotchas" section
