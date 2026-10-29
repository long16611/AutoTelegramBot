import { getDatabaseConnection } from './database.js';

const POLL_INTERVAL_MS = 2000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function claimNextTestTransaction(database) {
  await database.exec('BEGIN IMMEDIATE');
  try {
    const transaction = await database.get(
      `SELECT id, chat_id
       FROM transaction_queue
       WHERE status = 'PENDING' AND is_test = 1
       ORDER BY id ASC
       LIMIT 1`,
    );

    if (!transaction) {
      await database.exec('COMMIT');
      return null;
    }

    const result = await database.run(
      `UPDATE transaction_queue
       SET status = 'PROCESSING', error_message = NULL
       WHERE id = ? AND status = 'PENDING'`,
      transaction.id
    );
    if (result.changes !== 1) {
      throw new Error(`Unable to lock diagnostic transaction ${transaction.id}.`);
    }

    await database.exec('COMMIT');
    return transaction;
  } catch (error) {
    try {
      await database.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('Unable to roll back queue claim:', rollbackError);
    }
    throw error;
  }
}

export async function deployMacroProcessingLoop(botInstance, { signal } = {}) {
  const database = await getDatabaseConnection();
  console.info(
    'Roblox transfers are disabled until the transfer engine can verify the exact requested amount.'
  );

  while (!signal?.aborted) {
    let transaction;

    try {
      transaction = await claimNextTestTransaction(database);
      if (!transaction) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const result = await database.run(
        `UPDATE transaction_queue
         SET status = 'COMPLETED', error_message = NULL
         WHERE id = ? AND status = 'PROCESSING'`,
        transaction.id
      );
      if (result.changes !== 1) {
        throw new Error(`Unable to complete diagnostic transaction ${transaction.id}.`);
      }

      try {
        await botInstance.telegram.sendMessage(
          transaction.chat_id,
          `Diagnostic transaction #${transaction.id} completed. No Roblox transfer was attempted.`
        );
      } catch (error) {
        console.error(`Unable to notify chat ${transaction.chat_id}:`, error);
      }
    } catch (error) {
      console.error('Diagnostic worker cycle failed:', error);

      if (transaction) {
        try {
          await database.run(
            `UPDATE transaction_queue
             SET status = 'FAILED', error_message = ?
             WHERE id = ? AND status = 'PROCESSING'`,
            String(error.message ?? error).slice(0, 1000),
            transaction.id
          );
        } catch (updateError) {
          console.error(
            `Unable to mark diagnostic transaction ${transaction.id} as FAILED:`,
            updateError
          );
        }
      }
    }

    if (!signal?.aborted) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
}
