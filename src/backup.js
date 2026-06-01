// src/backup.js — Backup utilities for file modifications
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Global session ID - can be set per conversation
let currentSessionId = null;

/**
 * Set the current session ID for backup isolation
 * @param {string} sessionId - Unique identifier for the conversation
 */
function setSessionId(sessionId) {
  currentSessionId = sessionId;
}

/**
 * Get the backup directory path for the current session
 * @returns {string} Backup directory path
 */
function getBackupDir() {
  if (!currentSessionId) {
    // Generate a session ID based on timestamp if none set
    currentSessionId = `session_${Date.now()}`;
  }
  const backupRoot = path.join(process.cwd(), 'backups');
  const sessionDir = path.join(backupRoot, currentSessionId);
  return sessionDir;
}

/**
 * Create a backup of a file before modification
 * @param {string} filePath - Path to the file to backup
 * @returns {Promise<string|null>} Backup file path, or null if file doesn't exist
 */
async function createBackup(filePath) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  
  // Check if file exists
  if (!fs.existsSync(absPath)) {
    return null; // No backup needed for new files
  }
  
  // Check if it's a directory
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return null;
  }
  
  // Get backup directory (session root)
  const backupRoot = getBackupDir();
  
  // Use original relative path as backup filename, preserving directory structure
  const relativePath = path.relative(process.cwd(), absPath);
  // Convert Windows backslashes to forward slashes for consistency
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const backupPath = path.join(backupRoot, normalizedPath);
  
  // Check if backup already exists (first backup of this file in the session)
  if (fs.existsSync(backupPath)) {
    // Backup already exists, return existing backup path without overwriting
    return backupPath;
  }
  
  // Ensure parent directories exist in backup location
  const backupDirPath = path.dirname(backupPath);
  fs.mkdirSync(backupDirPath, { recursive: true });
  
  // Copy the file
  fs.copyFileSync(absPath, backupPath);
  
  return backupPath;
}

/**
 * Create a backup with metadata about the operation
 * @param {string} filePath - Path to the file
 * @param {string} operation - Operation type (write_file, append_to_file, etc.)
 * @returns {Promise<object>} Backup metadata
 */
async function createBackupWithMetadata(filePath, operation) {
  const backupPath = await createBackup(filePath);
  
  const metadata = {
    timestamp: Date.now(),
    operation,
    filePath,
    backupPath,
    sessionId: currentSessionId,
    fileExists: backupPath !== null,
    originalSize: backupPath ? fs.statSync(backupPath).size : 0
  };
  
  // Write metadata to a log file in the backup directory
  const backupDir = getBackupDir();
  const logPath = path.join(backupDir, 'backup_manifest.json');
  
  let manifest = [];
  if (fs.existsSync(logPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch (err) {
      // If manifest is corrupted, start fresh
      manifest = [];
    }
  }
  
  manifest.push(metadata);
  fs.writeFileSync(logPath, JSON.stringify(manifest, null, 2), 'utf8');
  
  return metadata;
}

/**
 * Create a backup of user input (task content) for the current session
 * @param {string} taskContent - The user's task description
 * @returns {Promise<object>} Backup metadata
 */
async function backupUserPrompt(taskContent) {
  if (!taskContent || typeof taskContent !== 'string') {
    throw new Error('Task content must be a non-empty string');
  }
  
  const backupDir = getBackupDir();
  const userInputsDir = path.join(backupDir, 'user_inputs');
  fs.mkdirSync(userInputsDir, { recursive: true });
  
  const timestamp = Date.now();
  const dateStr = new Date(timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFileName = `task_${dateStr}_${timestamp}.txt`;
  const backupPath = path.join(userInputsDir, backupFileName);
  
  // Write the task content with metadata header
  const content = [
    `Task Backup - ${new Date(timestamp).toISOString()}`,
    `Session ID: ${currentSessionId || 'unknown'}`,
    '─'.repeat(60),
    taskContent,
    '─'.repeat(60),
    `Backup created at: ${new Date(timestamp).toLocaleString()}`,
  ].join('\n');
  
  fs.writeFileSync(backupPath, content, 'utf8');
  
  // Update manifest with user prompt entry
  const manifestPath = path.join(backupDir, 'backup_manifest.json');
  let manifest = [];
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      manifest = [];
    }
  }
  
  const metadata = {
    timestamp,
    type: 'user_prompt',
    operation: 'backup_user_prompt',
    filePath: backupPath,
    sessionId: currentSessionId,
    taskLength: taskContent.length,
    taskPreview: taskContent.slice(0, 200) + (taskContent.length > 200 ? '...' : '')
  };
  
  manifest.push(metadata);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  
  return metadata;
}

/**
 * List all backups for the current session
 * @returns {Array} List of backup entries
 */
function listBackups() {
  const backupDir = getBackupDir();
  const logPath = path.join(backupDir, 'backup_manifest.json');
  
  if (!fs.existsSync(logPath)) {
    return [];
  }
  
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'));
  } catch (err) {
    return [];
  }
}

/**
 * Clear all backups for the current session
 */
function clearBackups() {
  const backupDir = getBackupDir();
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

module.exports = {
  setSessionId,
  getBackupDir,
  createBackup,
  createBackupWithMetadata,
  backupUserPrompt,
  listBackups,
  clearBackups
};
