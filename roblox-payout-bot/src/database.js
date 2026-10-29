import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

let connectionPromise;
const databasePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'payout_queue.db');

export async function getDatabaseConnection() {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const database = await open({
        filename: databasePath,
        driver: sqlite3.Database
      });

      await database.exec('PRAGMA journal_mode = WAL');
      await database.exec('PRAGMA busy_timeout = 5000');
      await database.exec(`
        CREATE TABLE IF NOT EXISTS transaction_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          amount INTEGER NOT NULL CHECK (amount > 0),
          status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),
          error_message TEXT,
          source_order_id INTEGER,
          roblox_user_id TEXT,
          roblox_display_name TEXT,
          recipient_confirmed INTEGER NOT NULL DEFAULT 0
            CHECK (recipient_confirmed IN (0, 1))
        )
      `);

      const columns = await database.all('PRAGMA table_info(transaction_queue)');
      const migrations = [
        ['source_order_id', 'INTEGER'],
        ['roblox_user_id', 'TEXT'],
        ['roblox_display_name', 'TEXT'],
        ['recipient_confirmed', 'INTEGER NOT NULL DEFAULT 0 CHECK (recipient_confirmed IN (0, 1))']
      ];
      for (const [name, definition] of migrations) {
        if (!columns.some((column) => column.name === name)) {
          await database.exec(
            `ALTER TABLE transaction_queue ADD COLUMN ${name} ${definition}`
          );
        }
      }
      await database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_queue_source_order_id
        ON transaction_queue(source_order_id)
      `);

      return database;
    })().catch((error) => {
      connectionPromise = undefined;
      throw error;
    });
  }

  return connectionPromise;
}

export async function closeDatabaseConnection() {
  if (!connectionPromise) {
    return;
  }

  const database = await connectionPromise;
  connectionPromise = undefined;
  await database.close();
}
