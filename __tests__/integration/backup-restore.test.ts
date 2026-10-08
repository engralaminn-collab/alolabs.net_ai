import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { LocalStorageProvider } from '@/lib/storage/local-storage';

describe('isolated real backup → restore (not production certification)', () => {
  it('preserves SQLite rows, private file bytes and tenant ownership metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alo-backup-'));
    try {
      const app = join(dir, 'app');
      const backups = join(dir, 'snapshots');
      const restore = join(dir, 'restored');
      mkdirSync(app); mkdirSync(backups); mkdirSync(restore);
      const dbFile = join(app, 'test.sqlite');
      const db = new Database(dbFile);
      db.exec("CREATE TABLE Evidence (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO Evidence VALUES ('one','preserved')");
      db.close();
      const storage = new LocalStorageProvider({ basePath: join(app, 'uploads') });
      const bytes = Buffer.from('private file retained after restore');
      const uploaded = await storage.upload(bytes, 'record.txt', {
        companyId: 'company-a', uploadedBy: 'user-a', folder: 'evidence',
      });
      writeFileSync(join(app, '.env'), `DATABASE_URL=file:${dbFile}\nSTORAGE_PROVIDER=local\nSTORAGE_LOCAL_PATH=${join(app, 'uploads')}\n`, { mode: 0o600 });
      execFileSync('bash', ['deploy/scripts/backup.sh'], {
        cwd: process.cwd(), env: { ...process.env, APP_DIR: app, BACKUP_DIR: backups, ENV_FILE: join(app, '.env') },
        timeout: 30000,
      });
      const snapshot = join(backups, readdirSync(backups)[0]);
      execFileSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: snapshot, timeout: 30000 });
      const restoredDb = new Database(join(snapshot, 'database.sqlite'), { readonly: true });
      try {
        expect(restoredDb.prepare('SELECT value FROM Evidence WHERE id=?').get('one')).toEqual({ value: 'preserved' });
        expect(restoredDb.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally { restoredDb.close(); }
      execFileSync('tar', ['-xzf', join(snapshot, 'application-storage.tar.gz'), '-C', restore], { timeout: 30000 });
      const restoredStorage = new LocalStorageProvider({ basePath: join(restore, 'uploads') });
      const metadata = await restoredStorage.getMetadata(uploaded.id);
      expect(metadata).toMatchObject({ companyId: 'company-a', uploadedBy: 'user-a', checksum: uploaded.checksum });
      const downloaded = await restoredStorage.download(uploaded.id);
      expect(downloaded).toEqual(bytes);
      expect(createHash('sha256').update(downloaded).digest('hex')).toBe(uploaded.checksum);
      const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
      expect(manifest).toMatchObject({ database_backup_verified: true, storage_included: true, restore_tested: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});
