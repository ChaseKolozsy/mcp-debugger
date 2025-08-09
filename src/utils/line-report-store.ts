/**
 * Line Report Store - SQLite-based storage for debug line reports
 * Stores detailed execution reports for each line stepped through during debugging
 */

import * as sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Logger } from 'winston';

export interface LineReport {
  id?: number;
  sessionId: string;
  file: string;
  lineNumber: number;
  code: string;
  timestamp: string;
  variables: Record<string, any>;
  stackDepth: number;
  threadId: number;
  observations?: string;
  status: 'success' | 'error' | 'warning';
  errorMessage?: string;
  errorType?: string;
  stackTrace?: string;
}

export interface SessionSummary {
  sessionId: string;
  file: string;
  language: string;
  startTime: string;
  endTime?: string;
  totalLinesExecuted: number;
  successfulLines: number;
  linesWithErrors: number;
  totalCrashes: number;
}

export class LineReportStore {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly logger: Logger;

  constructor(logger: Logger, dbPath?: string) {
    this.logger = logger;
    this.dbPath = dbPath || path.join(process.cwd(), '.claude', 'debug_reports', 'line_reports.db');
  }

  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });

      // Open database connection
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Create tables if they don't exist
      await this.createTables();
      
      this.logger.info(`[LineReportStore] Initialized database at ${this.dbPath}`);
    } catch (error) {
      this.logger.error('[LineReportStore] Failed to initialize database:', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Create line_reports table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS line_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        file TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        code TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        variables TEXT,
        stack_depth INTEGER,
        thread_id INTEGER,
        observations TEXT,
        status TEXT CHECK(status IN ('success', 'error', 'warning')),
        error_message TEXT,
        error_type TEXT,
        stack_trace TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_session_id (session_id),
        INDEX idx_file_line (file, line_number)
      )
    `);

    // Create session_summaries table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        file TEXT NOT NULL,
        language TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        total_lines_executed INTEGER DEFAULT 0,
        successful_lines INTEGER DEFAULT 0,
        lines_with_errors INTEGER DEFAULT 0,
        total_crashes INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.logger.debug('[LineReportStore] Tables created/verified');
  }

  async addLineReport(report: LineReport): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');

    const result = await this.db.run(`
      INSERT INTO line_reports (
        session_id, file, line_number, code, timestamp,
        variables, stack_depth, thread_id, observations,
        status, error_message, error_type, stack_trace
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      report.sessionId,
      report.file,
      report.lineNumber,
      report.code,
      report.timestamp,
      JSON.stringify(report.variables),
      report.stackDepth,
      report.threadId,
      report.observations,
      report.status,
      report.errorMessage,
      report.errorType,
      report.stackTrace
    ]);

    // Update session summary
    await this.updateSessionSummary(report.sessionId, report.status);

    this.logger.debug(`[LineReportStore] Added line report for session ${report.sessionId}, line ${report.lineNumber}`);
    return result.lastID!;
  }

  async createSession(summary: SessionSummary): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(`
      INSERT OR REPLACE INTO session_summaries (
        session_id, file, language, start_time, end_time,
        total_lines_executed, successful_lines, lines_with_errors, total_crashes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      summary.sessionId,
      summary.file,
      summary.language,
      summary.startTime,
      summary.endTime,
      summary.totalLinesExecuted,
      summary.successfulLines,
      summary.linesWithErrors,
      summary.totalCrashes
    ]);

    this.logger.info(`[LineReportStore] Created session ${summary.sessionId}`);
  }

  private async updateSessionSummary(sessionId: string, status: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const updates = ['total_lines_executed = total_lines_executed + 1'];
    
    if (status === 'success') {
      updates.push('successful_lines = successful_lines + 1');
    } else if (status === 'error') {
      updates.push('lines_with_errors = lines_with_errors + 1');
      updates.push('total_crashes = total_crashes + 1');
    }

    await this.db.run(`
      UPDATE session_summaries 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `, [sessionId]);
  }

  async getSessionReports(sessionId: string): Promise<LineReport[]> {
    if (!this.db) throw new Error('Database not initialized');

    const reports = await this.db.all<LineReport[]>(`
      SELECT * FROM line_reports 
      WHERE session_id = ? 
      ORDER BY id
    `, [sessionId]);

    return reports.map(report => ({
      ...report,
      variables: report.variables ? JSON.parse(report.variables as any) : {}
    }));
  }

  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    if (!this.db) throw new Error('Database not initialized');

    return await this.db.get<SessionSummary>(`
      SELECT * FROM session_summaries 
      WHERE session_id = ?
    `, [sessionId]);
  }

  async endSession(sessionId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    await this.db.run(`
      UPDATE session_summaries 
      SET end_time = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `, [new Date().toISOString(), sessionId]);

    this.logger.info(`[LineReportStore] Ended session ${sessionId}`);
  }

  async exportSessionAsJson(sessionId: string): Promise<string> {
    const reports = await this.getSessionReports(sessionId);
    const summary = await this.getSessionSummary(sessionId);

    const crashes = reports.filter(r => r.status === 'error').map(r => ({
      line_number: r.lineNumber,
      error_type: r.errorType,
      error_message: r.errorMessage,
      stack_trace: r.stackTrace,
      timestamp: r.timestamp
    }));

    const exportData = {
      session_info: summary,
      line_reports: reports,
      crashes,
      summary: {
        total_lines_executed: summary?.totalLinesExecuted || 0,
        successful_lines: summary?.successfulLines || 0,
        lines_with_errors: summary?.linesWithErrors || 0,
        total_crashes: summary?.totalCrashes || 0,
        start_time: summary?.startTime,
        end_time: summary?.endTime
      }
    };

    return JSON.stringify(exportData, null, 2);
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.logger.info('[LineReportStore] Database connection closed');
    }
  }
}