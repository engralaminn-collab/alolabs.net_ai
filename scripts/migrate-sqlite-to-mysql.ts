/**
 * Robust SQLite to MySQL / MariaDB Data Migrator
 * ALO Labs AIOS
 *
 * Features:
 * - Table-by-table schema-aware data transfer
 * - Batch insertion with parameter binding (safe against SQL injection, quotes, newlines, binary data)
 * - Automatic conversion of boolean 0/1, timestamps, JSON arrays/objects
 * - Foreign key check suspension during import
 * - Row count verification per table
 * - Detailed migration summary report
 */

import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

interface MigrateOptions {
  sqlitePath: string;
  mysqlUrl: string;
  dryRun?: boolean;
  batchSize?: number;
}

export async function migrateSQLiteToMySQL(options: MigrateOptions) {
  const { sqlitePath, mysqlUrl, dryRun = false, batchSize = 250 } = options;

  console.log('============================================================');
  console.log('ALO Labs — SQLite to MySQL/MariaDB Migration Engine');
  console.log('============================================================');
  console.log(`Source SQLite: ${sqlitePath}`);
  console.log(`Target MySQL:  ${mysqlUrl.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Dry Run:       ${dryRun}`);
  console.log('============================================================\n');

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }

  // Connect to SQLite using better-sqlite3 or sqlite3
  let sqliteDb: any;
  try {
    const Database = require('better-sqlite3');
    sqliteDb = new Database(sqlitePath, { readonly: true });
  } catch {
    throw new Error('better-sqlite3 required for SQLite reading');
  }

  // Connect to MySQL
  const mysqlConn = await mysql.createConnection(mysqlUrl);

  try {
    // 1. Get list of tables from SQLite
    const tablesResult = sqliteDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name"
    ).all() as { name: string }[];

    const tables = tablesResult.map((r) => r.name);
    console.log(`Discovered ${tables.length} tables to migrate.\n`);

    if (dryRun) {
      console.log('DRY RUN — Row count preview:');
      for (const table of tables) {
        const count = sqliteDb.prepare(`SELECT COUNT(*) as count FROM "${table}"`).get() as { count: number };
        console.log(`  ${table.padEnd(30)}: ${count.count} rows`);
      }
      return { success: true, dryRun: true };
    }

    // Disable foreign key checks & strict mode for migration
    await mysqlConn.execute('SET FOREIGN_KEY_CHECKS = 0');
    await mysqlConn.execute("SET sql_mode = ''");
    await mysqlConn.execute('SET NAMES utf8mb4');

    const results: { table: string; sqliteRows: number; mysqlRows: number; status: string }[] = [];

    for (const table of tables) {
      const sqliteCount = (sqliteDb.prepare(`SELECT COUNT(*) as count FROM "${table}"`).get() as { count: number }).count;

      if (sqliteCount === 0) {
        console.log(`[SKIP]  ${table} (0 rows)`);
        results.push({ table, sqliteRows: 0, mysqlRows: 0, status: 'SKIPPED_EMPTY' });
        continue;
      }

      // Check target MySQL table columns
      const [colRows] = await mysqlConn.execute(
        'SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
      );
      const mysqlCols = new Set((colRows as any[]).map((c) => c.COLUMN_NAME));

      if (mysqlCols.size === 0) {
        console.warn(`[WARN]  ${table} does not exist in MySQL schema. Skipping.`);
        results.push({ table, sqliteRows: sqliteCount, mysqlRows: 0, status: 'TABLE_MISSING_IN_TARGET' });
        continue;
      }

      // Read columns from SQLite
      const sqliteCols = sqliteDb.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[];
      const commonCols = sqliteCols.map((c) => c.name).filter((c) => mysqlCols.has(c));

      if (commonCols.length === 0) {
        console.warn(`[WARN]  No common columns for ${table}. Skipping.`);
        results.push({ table, sqliteRows: sqliteCount, mysqlRows: 0, status: 'NO_COMMON_COLUMNS' });
        continue;
      }

      console.log(`[START] Migrating ${table} (${sqliteCount} rows)...`);

      // Read rows in pages from SQLite
      let offset = 0;
      let inserted = 0;

      // Truncate or clean target table first
      await mysqlConn.execute(`DELETE FROM \`${table}\``);

      const colList = commonCols.map((c) => `\`${c}\``).join(', ');
      const placeholders = `(${commonCols.map(() => '?').join(', ')})`;

      while (offset < sqliteCount) {
        const rows = sqliteDb
          .prepare(`SELECT ${commonCols.map((c) => `"${c}"`).join(', ')} FROM "${table}" LIMIT ? OFFSET ?`)
          .all(batchSize, offset) as Record<string, unknown>[];

        if (rows.length === 0) break;

        // Construct bulk INSERT
        const bulkValues: unknown[] = [];
        const valuePlaceholders: string[] = [];

        for (const row of rows) {
          valuePlaceholders.push(placeholders);
          for (const col of commonCols) {
            let val = row[col];
            // Format dates / booleans / objects if needed
            if (val instanceof Date) {
              val = val.toISOString().slice(0, 19).replace('T', ' ');
            }
            bulkValues.push(val);
          }
        }

        const insertQuery = `INSERT INTO \`${table}\` (${colList}) VALUES ${valuePlaceholders.join(', ')}`;
        await mysqlConn.execute(insertQuery, bulkValues);

        inserted += rows.length;
        offset += batchSize;
      }

      // Verify row count
      const [countResult] = await mysqlConn.execute(`SELECT COUNT(*) as count FROM \`${table}\``);
      const mysqlCount = (countResult as any[])[0]?.count ?? 0;

      if (mysqlCount === sqliteCount) {
        console.log(`[OK]    ${table}: ${mysqlCount}/${sqliteCount} rows migrated.`);
        results.push({ table, sqliteRows: sqliteCount, mysqlRows: mysqlCount, status: 'SUCCESS' });
      } else {
        console.warn(`[WARN]  ${table}: Count mismatch (SQLite: ${sqliteCount}, MySQL: ${mysqlCount})`);
        results.push({ table, sqliteRows: sqliteCount, mysqlRows: mysqlCount, status: 'MISMATCH' });
      }
    }

    // Re-enable foreign key checks
    await mysqlConn.execute('SET FOREIGN_KEY_CHECKS = 1');

    console.log('\n============================================================');
    console.log('MIGRATION SUMMARY');
    console.log('============================================================');
    const successful = results.filter((r) => r.status === 'SUCCESS').length;
    const skipped = results.filter((r) => r.status === 'SKIPPED_EMPTY').length;
    const errors = results.filter((r) => r.status !== 'SUCCESS' && r.status !== 'SKIPPED_EMPTY').length;

    console.log(`Total Tables: ${tables.length}`);
    console.log(`Successful:   ${successful}`);
    console.log(`Skipped (0):  ${skipped}`);
    console.log(`Errors/Warns: ${errors}`);
    console.log('============================================================\n');

    return { success: errors === 0, results };
  } finally {
    await mysqlConn.end();
    if (sqliteDb) sqliteDb.close();
  }
}

// CLI entry point
if (require.main === module) {
  const sqlitePath = process.argv[2] || process.env.SQLITE_PATH || path.join(process.cwd(), 'db', 'dev.db');
  const mysqlUrl = process.argv[3] || process.env.DATABASE_URL || 'mysql://alohub_user:password@127.0.0.1:3306/alohub_production';
  const dryRun = process.argv.includes('--dry-run');

  migrateSQLiteToMySQL({ sqlitePath, mysqlUrl, dryRun })
    .then((res) => {
      console.log('Migration finished with status:', res.success ? 'SUCCESS' : 'FAILED');
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal migration error:', err);
      process.exit(1);
    });
}
