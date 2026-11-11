import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root directory
const projectRoot = path.resolve(__dirname, '..', '..');
const logFilePath = path.join(projectRoot, 'server.log');

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

class Logger {
  private logFileStream: fs.WriteStream | null = null;

  constructor() {
    try {
      this.logFileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    } catch {
      // In case write stream fails, fallback to stderr exclusively
      this.logFileStream = null;
    }
  }

  private formatMessage(level: LogLevel, message: string, meta?: unknown): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta !== undefined ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}\n`;
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    const formatted = this.formatMessage(level, message, meta);

    // CRITICAL: NEVER write to process.stdout!
    // process.stdout is strictly reserved for MCP JSON-RPC protocol messages.
    process.stderr.write(formatted);

    if (this.logFileStream && !this.logFileStream.destroyed) {
      try {
        this.logFileStream.write(formatted);
      } catch {
        // Silently ignore file write error to prevent crash
      }
    }
  }

  public debug(message: string, meta?: unknown): void {
    this.write('DEBUG', message, meta);
  }

  public info(message: string, meta?: unknown): void {
    this.write('INFO', message, meta);
  }

  public warn(message: string, meta?: unknown): void {
    this.write('WARN', message, meta);
  }

  public error(message: string, meta?: unknown): void {
    this.write('ERROR', message, meta);
  }

  public close(): void {
    if (this.logFileStream) {
      this.logFileStream.end();
    }
  }
}

export const logger = new Logger();
