// src/tools.js — All tools available to the AI agent
'use strict';

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');
const http          = require('http');
const https         = require('https');
const config        = require('./config');
const backup        = require('./backup');

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Convert any line ending to LF (\n) */
function toLF(str) {
  if (!str) return '';
  return String(str).replace(/\r\n|\r/g, '\n');
}

/** Convert any line ending to CRLF (\r\n) */
function toCRLF(str) {
  if (!str) return '';
  // First normalize to LF, then replace with CRLF
  return toLF(str).replace(/\n/g, '\r\n');
}

/** Read a file and return its content with LF line endings */
function readFileNormalized(filePath) {
  return toLF(fs.readFileSync(filePath, 'utf8'));
}

/** Write content to file with CRLF line endings */
function writeFileNormalized(filePath, content) {
  fs.writeFileSync(filePath, toCRLF(content), 'utf8');
}

/** Append content to file with CRLF line endings */
function appendFileNormalized(filePath, content) {
  fs.appendFileSync(filePath, toCRLF(content), 'utf8');
}

/** Truncate long strings so they don't blow up the context window */
function truncate(str, max = config.MAX_OUTPUT_LENGTH) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n\n⚠ [OUTPUT TRUNCATED — ${s.length.toLocaleString()} chars total, showing first & last ${half} chars]\n\n` +
    s.slice(-half)
  );
}

/** Resolve a path relative to the working directory */
function resolve(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(config.WORKING_DIR, filePath);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/** Escape a string for use inside a PowerShell single-quoted argument */
function escapePS(str) {
  if (typeof str !== 'string') return String(str);
  // Replace single quotes with two single quotes (PowerShell escape)
  return str.replace(/'/g, "''");
}

// ─────────────────────────────────────────────
//  Tool definitions
// ─────────────────────────────────────────────

const TOOLS = {

  // ── File Reading ────────────────────────────────────────────────────────────
  read_file: {
    description: 'Read the full contents of a file. Optionally read specific line ranges.',
    parameters: {
      path        : { type: 'string',  required: true,  description: 'Path to the file' },
      start_line  : { type: 'number',  required: false, description: 'First line to read (1-indexed)' },
      end_line    : { type: 'number',  required: false, description: 'Last line to read (inclusive)' },
    },
    async execute({ path: filePath, start_line, end_line }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs))       throw new Error(`File not found: ${filePath}`);
      if (fs.statSync(abs).isDirectory()) throw new Error(`${filePath} is a directory`);

      // Read with normalized LF line endings
      let content = readFileNormalized(abs);
      const lines = content.split('\n');
      const totalLines = lines.length;

      if (start_line != null || end_line != null) {
        const s = Math.max(0, (start_line || 1) - 1);
        const e = end_line != null ? end_line : totalLines;
        const sliced = lines.slice(s, e);
        const numbered = sliced.map((l, i) => `${s + i + 1}:${l}`).join('\n');
        return `[${filePath} | lines ${s + 1}–${e}]\n${truncate(numbered)}`;
      }

      // Always output line numbers for the whole file
      const numbered = lines.map((l, i) => `${i + 1}:${l}`).join('\n');
      return `[${filePath} | ${totalLines} lines]\n${truncate(numbered)}`;
    },
  },

  // ── File Writing ────────────────────────────────────────────────────────────
  write_file: {
    description: 'Write (create or overwrite) a file with given content. Creates parent directories automatically.',
    parameters: {
      path    : { type: 'string', required: true, description: 'Destination file path' },
      content : { type: 'string', required: true, description: 'Full file content to write' },
    },
    async execute({ path: filePath, content }) {
      const abs = resolve(filePath);
      // Create backup before modifying
      try {
        await backup.createBackupWithMetadata(abs, 'write_file');
      } catch (err) {
        // Log but don't fail if backup fails
        console.error(`Backup failed for ${filePath}:`, err);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeFileNormalized(abs, content);
      const lineCount = toLF(content).split('\n').length;
      return `✓ Wrote ${formatBytes(Buffer.byteLength(toCRLF(content), 'utf8'))} (${lineCount} lines) → ${filePath}`;
    },
  },

  // ── Append to File ──────────────────────────────────────────────────────────
  append_to_file: {
    description: 'Append text to the end of an existing file (or create it if missing).',
    parameters: {
      path    : { type: 'string', required: true, description: 'File path' },
      content : { type: 'string', required: true, description: 'Text to append' },
    },
    async execute({ path: filePath, content }) {
      const abs = resolve(filePath);
      // Create backup before modifying (if file exists)
      try {
        await backup.createBackupWithMetadata(abs, 'append_to_file');
      } catch (err) {
        // Log but don't fail if backup fails
        console.error(`Backup failed for ${filePath}:`, err);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      appendFileNormalized(abs, content);
      return `✓ Appended ${formatBytes(Buffer.byteLength(toCRLF(content), 'utf8'))} to ${filePath}`;
    },
  },

  // ── Find & Replace in File ──────────────────────────────────────────────────
  replace_in_file: {
    description: 'Find and replace text in a file. Supports regex patterns.',
    parameters: {
      path           : { type: 'string',  required: true,  description: 'File path' },
      find           : { type: 'string',  required: true,  description: 'Text to find' },
      replace        : { type: 'string',  required: true,  description: 'Replacement text' },
      use_regex      : { type: 'boolean', required: false, description: 'Treat "find" as a regex pattern (default: false)' },
      all_occurrences: { type: 'boolean', required: false, description: 'Replace all occurrences (default: true)' },
    },
    async execute({ path: filePath, find, replace, use_regex = false, all_occurrences = true }) {
      const abs = resolve(filePath);
      // Create backup before modifying
      try {
        await backup.createBackupWithMetadata(abs, 'replace_in_file');
      } catch (err) {
        // Log but don't fail if backup fails
        console.error(`Backup failed for ${filePath}:`, err);
      }
      // Read current content with LF line endings
      let content = readFileNormalized(abs);
      const original = content;

      // Normalize find and replace strings to LF so they match the LF content
      const normalizedFind = toLF(find);
      const normalizedReplace = toLF(replace);

      if (use_regex) {
        const re = new RegExp(normalizedFind, all_occurrences ? 'g' : '');
        content = content.replace(re, normalizedReplace);
      } else if (all_occurrences) {
        content = content.split(normalizedFind).join(normalizedReplace);
      } else {
        content = content.replace(normalizedFind, normalizedReplace);
      }

      if (content === original) {
        return `⚠ No matches found for "${find}" in ${filePath}`;
      }

      // Count occurrences (using normalizedFind)
      let count;
      if (use_regex) {
        const re = new RegExp(normalizedFind, 'g');
        count = (original.match(re) || []).length;
      } else {
        const escapedFind = normalizedFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escapedFind, 'g');
        count = (original.match(re) || []).length;
      }

      // Write back with CRLF line endings
      writeFileNormalized(abs, content);
      return `✓ Replaced ${count} occurrence(s) of "${find}" in ${filePath}`;
    },
  },

  // ── Delete File ─────────────────────────────────────────────────────────────
  delete_file: {
    description: 'Permanently delete a file.',
    parameters: {
      path: { type: 'string', required: true, description: 'File to delete' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
      // Create backup before deletion
      try {
        await backup.createBackupWithMetadata(abs, 'delete_file');
      } catch (err) {
        // Log but don't fail if backup fails
        console.error(`Backup failed for ${filePath}:`, err);
      }
      fs.unlinkSync(abs);
      return `✓ Deleted ${filePath}`;
    },
  },

  // ── List Directory ──────────────────────────────────────────────────────────
  list_directory: {
    description: 'List files and folders in a directory, optionally recursive.',
    parameters: {
      path        : { type: 'string',  required: false, description: 'Directory to list (default: working dir)' },
      recursive   : { type: 'boolean', required: false, description: 'Recurse into sub-directories (default: false)' },
      show_hidden : { type: 'boolean', required: false, description: 'Include hidden files starting with . (default: false)' },
    },
    async execute({ path: dirPath = '.', recursive = false, show_hidden = false }) {
      const abs = resolve(dirPath);
      if (!fs.existsSync(abs))        throw new Error(`Directory not found: ${dirPath}`);
      if (!fs.statSync(abs).isDirectory()) throw new Error(`${dirPath} is not a directory`);

      if (recursive) {
        // Use PowerShell Get-ChildItem with recursion, filtering out common noise folders
        const hiddenFilter = show_hidden ? '' : '-Force'; // -Force includes hidden files; if not show_hidden we need to filter later
        // Build filter regex for excluded directories
        const excludePattern = 'node_modules|\\.git|dist';
        // PowerShell command: get all files/dirs recursively, exclude unwanted folders, sort by fullname, take first 300
        let psCmd = `Get-ChildItem -Path '${escapePS(abs)}' -Recurse`;
        if (!show_hidden) {
          psCmd += ` | Where-Object { $_.Name -notlike '.*' }`;
        }
        psCmd += ` | Where-Object { $_.FullName -notmatch '${excludePattern}' }`;
        psCmd += ` | Sort-Object FullName | Select-Object -First 300 | ForEach-Object { $_.FullName }`;
        const out = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' }).trim();
        return out || '(empty)';
      }

      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const visible = show_hidden ? entries : entries.filter(e => !e.name.startsWith('.'));
      visible.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      if (visible.length === 0) return `(empty directory: ${dirPath})`;

      const lines = visible.map(e => {
        if (e.isDirectory()) {
          return `📁  ${e.name}/`;
        }
        try {
          const size = fs.statSync(path.join(abs, e.name)).size;
          return `📄  ${e.name}  ${formatBytes(size)}`;
        } catch {
          return `📄  ${e.name}`;
        }
      });

      return `[${dirPath}] — ${visible.length} items\n${lines.join('\n')}`;
    },
  },

  // ── Create Directory ────────────────────────────────────────────────────────
  create_directory: {
    description: 'Create a directory (and all necessary parent directories).',
    parameters: {
      path: { type: 'string', required: true, description: 'Directory path to create' },
    },
    async execute({ path: dirPath }) {
      const abs = resolve(dirPath);
      fs.mkdirSync(abs, { recursive: true });
      return `✓ Created directory: ${dirPath}`;
    },
  },

  // ── Move / Rename ───────────────────────────────────────────────────────────
  move_file: {
    description: 'Move or rename a file or directory.',
    parameters: {
      source      : { type: 'string', required: true, description: 'Source path' },
      destination : { type: 'string', required: true, description: 'Destination path' },
    },
    async execute({ source, destination }) {
      const src  = resolve(source);
      const dest = resolve(destination);
      if (!fs.existsSync(src)) throw new Error(`Source not found: ${source}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      return `✓ Moved: ${source} → ${destination}`;
    },
  },

  // ── Copy File ───────────────────────────────────────────────────────────────
  copy_file: {
    description: 'Copy a file to a new location.',
    parameters: {
      source      : { type: 'string', required: true, description: 'Source file path' },
      destination : { type: 'string', required: true, description: 'Destination file path' },
    },
    async execute({ source, destination }) {
      const src  = resolve(source);
      const dest = resolve(destination);
      if (!fs.existsSync(src)) throw new Error(`Source not found: ${source}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return `✓ Copied: ${source} → ${destination}`;
    },
  },

  // ── File Info ───────────────────────────────────────────────────────────────
  get_file_info: {
    description: 'Get metadata about a file or directory (size, modified date, line count, etc.).',
    parameters: {
      path: { type: 'string', required: true, description: 'File or directory path' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      if (!fs.existsSync(abs)) throw new Error(`Not found: ${filePath}`);
      const stat = fs.statSync(abs);
      const info = {
        path        : abs,
        type        : stat.isDirectory() ? 'directory' : 'file',
        size        : stat.size,
        size_human  : formatBytes(stat.size),
        modified    : stat.mtime.toISOString(),
        created     : stat.birthtime.toISOString(),
        permissions : `0${(stat.mode & 0o777).toString(8)}`,
      };
      if (stat.isFile()) {
        const content = readFileNormalized(abs);
        info.lines = content.split('\n').length;
        info.encoding = 'utf-8';
      }
      return JSON.stringify(info, null, 2);
    },
  },

  // ── Run Command ─────────────────────────────────────────────────────────────
  run_command: {
    description: 'Execute a shell command and return its output. Runs in the working directory by default.',
    parameters: {
      command : { type: 'string',  required: true,  description: 'Shell command to run' },
      cwd     : { type: 'string',  required: false, description: 'Working directory for the command' },
      timeout : { type: 'number',  required: false, description: 'Timeout in milliseconds (default: 60000)' },
      env     : { type: 'object',  required: false, description: 'Extra environment variables as key-value pairs' },
    },
    async execute({ command, cwd, timeout = 60_000, env = {} }) {
      const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;

      try {
        const output = execSync(command, {
          cwd         : workDir,
          encoding    : 'utf8',
          timeout,
          maxBuffer   : 20 * 1024 * 1024,
          env         : { ...process.env, ...env },
          stdio       : ['pipe', 'pipe', 'pipe'],
        });
        const result = (output || '').trim();
        return truncate(result || '(command completed with no output)');
      } catch (err) {
        const stdout = (err.stdout || '').trim();
        const stderr = (err.stderr || '').trim();
        const combined = [
          stdout && `STDOUT:\n${stdout}`,
          stderr && `STDERR:\n${stderr}`,
        ].filter(Boolean).join('\n\n');
        throw new Error(`Command failed (exit code ${err.status}):\n${truncate(combined || err.message)}`);
      }
    },
  },

  // ── Find Files ──────────────────────────────────────────────────────────────
  find_files: {
    description: 'Search for files by name pattern (glob-style, e.g. "*.js", "test_*").',
    parameters: {
      pattern   : { type: 'string', required: true,  description: 'Filename pattern (e.g. "*.ts")' },
      directory : { type: 'string', required: false, description: 'Directory to search (default: working dir)' },
      exclude   : { type: 'string', required: false, description: 'Pattern to exclude from results' },
    },
    async execute({ pattern, directory = '.', exclude }) {
      const dir = resolve(directory);
      let excludePattern = 'node_modules|build|debug|release|backups|\\.git|dist';
      if (exclude) {
        excludePattern += `|${escapePS(exclude)}`;
      }
      // Use PowerShell: Get-ChildItem -Recurse -Filter, then filter out excluded folders
      const psCmd = `Get-ChildItem -Path '${escapePS(dir)}' -Recurse -Filter '${escapePS(pattern)}' -File | Where-Object { $_.FullName -notmatch '${excludePattern}' } | Sort-Object FullName | Select-Object -First 100 | ForEach-Object { $_.FullName }`;
      let result;
      try {
        result = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' }).trim();
      } catch (err) {
        if (err.status === 1) return `No files matching "${pattern}" in ${directory}`;
        throw err;
      }
      return result || `No files matching "${pattern}" in ${directory}`;
    },
  },

  // ── Search in Files (grep) ───────────────────────────────────────────────────
  search_in_files: {
    description: 'Search for text patterns inside files (like grep -r). Returns matching lines with filenames.',
    parameters: {
      pattern       : { type: 'string',  required: true,  description: 'Text or regex to search for' },
      directory     : { type: 'string',  required: false, description: 'Directory to search (default: working dir)' },
      file_pattern  : { type: 'string',  required: false, description: 'Only search files matching this (e.g. "*.js")' },
      case_sensitive: { type: 'boolean', required: false, description: 'Case-sensitive search (default: false)' },
      context_lines : { type: 'number',  required: false, description: 'Lines of context around each match (default: 2)' },
    },
    async execute({ pattern, directory = '.', file_pattern, case_sensitive = false, context_lines = 2 }) {
      const dir = resolve(directory);
      if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${directory}`);
      
      // 构建正则表达式
      let regex;
      const flags = case_sensitive ? '' : 'i';
      try {
        // 尝试作为正则表达式解析
        regex = new RegExp(pattern, flags);
      } catch {
        // 如果不是有效正则，转义特殊字符后作为普通字符串匹配
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, flags);
      }
      
      // 文件模式匹配（glob 转正则）
      let fileMatcher = null;
      if (file_pattern) {
        const globToRegex = (glob) => {
          const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                            .replace(/\*/g, '.*')
                            .replace(/\?/g, '.');
          return new RegExp(`^${escaped}$`, 'i');
        };
        fileMatcher = globToRegex(file_pattern);
      }
      
      // 排除目录（正则匹配目录名或路径片段）
      const excludeDirs = /node_modules|build|debug|release|\.git|dist|__pycache__|backups|venv|\.idea|\.vscode/;
      
      const results = [];
      const MAX_RESULTS = 150;
      const MAX_FILE_SIZE = 5 * 1024 * 1024; // 跳过超过 5MB 的文件
      
      // 递归遍历目录
      function walk(currentDir) {
        if (results.length >= MAX_RESULTS) return;
        let entries;
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
          return; // 忽略权限错误
        }
        
        for (const entry of entries) {
          if (results.length >= MAX_RESULTS) break;
          const fullPath = path.join(currentDir, entry.name);
          
          if (entry.isDirectory()) {
            // 跳过排除的目录
            if (excludeDirs.test(entry.name) || excludeDirs.test(fullPath)) continue;
            walk(fullPath);
          } else if (entry.isFile()) {
            // 文件模式过滤
            if (fileMatcher && !fileMatcher.test(entry.name)) continue;
            
            // 跳过超大文件
            let stats;
            try {
              stats = fs.statSync(fullPath);
              if (stats.size > MAX_FILE_SIZE) continue;
            } catch { continue; }
            
            // 检测二进制文件（读取前 1KB，若含 null 字节则跳过）
            let isBinary = false;
            try {
              const fd = fs.openSync(fullPath, 'r');
              const buffer = Buffer.alloc(1024);
              const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
              fs.closeSync(fd);
              if (buffer.slice(0, bytesRead).includes(0)) isBinary = true;
            } catch { continue; }
            if (isBinary) continue;
            
            // 读取文件内容（UTF-8）
            let content;
            try {
              content = fs.readFileSync(fullPath, 'utf8');
            } catch {
              continue; // 编码问题跳过
            }
            
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_RESULTS) break;
              if (regex.test(lines[i])) {
                // 提取上下文行
                const start = Math.max(0, i - context_lines);
                const end = Math.min(lines.length - 1, i + context_lines);
                const contextParts = [];
                for (let j = start; j <= end; j++) {
                  const prefix = (j === i) ? '>>>' : '   ';
                  contextParts.push(`${prefix} ${j+1}: ${lines[j]}`);
                }
                const relativePath = path.relative(dir, fullPath);
                results.push(`[${relativePath}:${i+1}]\n${contextParts.join('\n')}\n`);
              }
            }
          }
        }
      }
      
      walk(dir);
      
      if (results.length === 0) {
        return `No matches found for: ${pattern}`;
      }
      return truncate(results.join('\n').trim());
    },
  },

  // ── Ask User ──────────────────────────────────────────────────────────────
  ask_user: {
    description: 'Ask the user a question and wait for their response. Useful when you need clarification, approval, or suggestions from the user.',
    parameters: {
      question: { type: 'string', required: true, description: 'The question to ask the user' },
      options: { type: 'array', required: false, description: 'Optional list of options for the user to choose from (e.g., ["Yes", "No", "Cancel"])' },
    },
    async execute({ question, options }) {
      // Return a special marker that the agent loop will recognize
      // The agent will display this to the user and wait for input
      return {
        __ask_user: true,
        question: question,
        options: options || []
      };
    },
  },

  // ── Fetch URL ───────────────────────────────────────────────────────────────
  read_url: {
    description: 'Fetch the text content of a URL (useful for reading documentation, APIs, etc.).',
    parameters: {
      url: { type: 'string', required: true, description: 'Full URL to fetch (http or https)' },
    },
    async execute({ url }) {
      return new Promise((resolve_p, reject) => {
        const client  = url.startsWith('https') ? https : http;
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekAgent/1.0)',
            'Accept'    : 'text/html,text/plain,application/json',
          },
        };

        const req = client.get(url, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return TOOLS.read_url.execute({ url: res.headers.location }).then(resolve_p).catch(reject);
          }

          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            const text = data
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s{3,}/g, '\n\n')
              .trim();
            resolve_p(truncate(text));
          });
        });

        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(); reject(new Error('URL fetch timed out')); });
      });
    },
  },

  // ── Write Multiple Files (batch) ────────────────────────────────────────────
  write_files: {
    description: 'Write multiple files at once — useful for scaffolding projects.',
    parameters: {
      files: {
        type       : 'array',
        required   : true,
        description: 'Array of {path, content} objects',
      },
    },
    async execute({ files }) {
      if (!Array.isArray(files)) throw new Error('"files" must be an array of {path, content}');
      const results = [];
      for (const { path: filePath, content } of files) {
        const abs = resolve(filePath);
        // Create backup before writing
        try {
          await backup.createBackupWithMetadata(abs, 'write_files');
        } catch (err) {
          // Log but don't fail if backup fails
          console.error(`Backup failed for ${filePath}:`, err);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        writeFileNormalized(abs, content);
        results.push(`✓ ${filePath}`);
      }
      return `Wrote ${results.length} files:\n${results.join('\n')}`;
    },
  },

};

// ─────────────────────────────────────────────
//  Generate tool docs for the system prompt
// ─────────────────────────────────────────────
function getToolDescriptions() {
  return Object.entries(TOOLS).map(([name, tool]) => {
    const paramLines = Object.entries(tool.parameters || {}).map(([pName, p]) =>
      `    - ${pName} (${p.type}${p.required ? ', REQUIRED' : ''}): ${p.description || ''}`
    ).join('\n');

    return `### ${name}\n  ${tool.description}\n  Parameters:\n${paramLines}`;
  }).join('\n\n');
}

// ─────────────────────────────────────────────
//  Execute a tool by name
// ─────────────────────────────────────────────
async function executeTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) {
    const available = Object.keys(TOOLS).join(', ');
    throw new Error(`Unknown tool: "${name}". Available tools: ${available}`);
  }
  return await tool.execute(args);
}

module.exports = { TOOLS, executeTool, getToolDescriptions };