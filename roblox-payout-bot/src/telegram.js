import { Markup, Telegraf } from 'telegraf';
import { getDatabaseConnection } from './database.js';
import { resolveRobloxUsername } from './roblox.js';

const MAX_TEST_VOLUME = 50;
const ROBLOX_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{1,18}[A-Za-z0-9]$/;

export function attachPayoutFlow(bot) {
  const activePaymentsByChatId = new Map();
  const pendingPaymentsByChatId = new Map();

  const sendActivePrompt = async (chatId, payment) => {
    try {
      await bot.telegram.sendMessage(
        chatId,
        `A payout of ${payment.amount} Robux is ready. Reply with your Roblox username.`
      );
    } catch (error) {
      if (activePaymentsByChatId.get(chatId) === payment) {
        activePaymentsByChatId.delete(chatId);
      }
      throw error;
    }
  };

  const activateNextPrompt = async (chatId) => {
    const pending = pendingPaymentsByChatId.get(chatId);
    if (!pending?.length) {
      pendingPaymentsByChatId.delete(chatId);
      return;
    }

    const nextPayment = pending.shift();
    if (pending.length === 0) {
      pendingPaymentsByChatId.delete(chatId);
    }
    activePaymentsByChatId.set(chatId, nextPayment);
    await sendActivePrompt(chatId, nextPayment);
  };

  bot.handleExternalPayment = async (chatId, amount, sourceOrderId) => {
    const numericChatId = Number(chatId);
    if (!Number.isSafeInteger(numericChatId)) {
      throw new TypeError('chatId must be a safe integer.');
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new TypeError('amount must be a positive safe integer.');
    }

    if (sourceOrderId !== undefined && !Number.isSafeInteger(Number(sourceOrderId))) {
      throw new TypeError('sourceOrderId must be a safe integer when provided.');
    }

    const payment = {
      amount,
      sourceOrderId: sourceOrderId === undefined ? null : Number(sourceOrderId),
      startedAt: Date.now()
    };

    if (payment.sourceOrderId !== null) {
      const database = await getDatabaseConnection();
      await database.run(
        `INSERT INTO transaction_queue
          (chat_id, username, amount, status, is_test, source_order_id)
         VALUES (?, '', ?, 'PENDING', 0, ?)
         ON CONFLICT(source_order_id) DO NOTHING`,
        numericChatId,
        amount,
        payment.sourceOrderId
      );

      const existing = await database.get(
        `SELECT chat_id, amount, username, status
         FROM transaction_queue
         WHERE source_order_id = ?`,
        payment.sourceOrderId
      );
      if (!existing || existing.chat_id !== numericChatId || existing.amount !== amount) {
        throw new Error(`Payout queue entry does not match order ${payment.sourceOrderId}.`);
      }
      if (existing.username || existing.status !== 'PENDING') {
        return false;
      }
    }

    const activePayment = activePaymentsByChatId.get(numericChatId);
    if (
      payment.sourceOrderId !== null &&
      activePayment?.sourceOrderId === payment.sourceOrderId
    ) {
      return false;
    }
    const pending = pendingPaymentsByChatId.get(numericChatId) ?? [];
    if (
      payment.sourceOrderId !== null &&
      pending.some((entry) => entry.sourceOrderId === payment.sourceOrderId)
    ) {
      return false;
    }

    if (activePayment) {
      pending.push(payment);
      pendingPaymentsByChatId.set(numericChatId, pending);
      return true;
    }

    activePaymentsByChatId.set(numericChatId, payment);
    await sendActivePrompt(numericChatId, payment);
    return true;
  };

  bot.command('testpay', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Use /testpay in a private chat with this bot.');
      return;
    }

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    if (args.length > 1 || (args.length === 1 && !/^\d+$/.test(args[0]))) {
      await ctx.reply(`Usage: /testpay [1-${MAX_TEST_VOLUME}]`);
      return;
    }

    const volume = args.length === 0 ? 1 : Number(args[0]);
    if (!Number.isSafeInteger(volume) || volume < 1 || volume > MAX_TEST_VOLUME) {
      await ctx.reply(`Test volume must be between 1 and ${MAX_TEST_VOLUME}.`);
      return;
    }

    const database = await getDatabaseConnection();
    await database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 1; index <= volume; index += 1) {
        await database.run(
          `INSERT INTO transaction_queue
            (chat_id, username, amount, status, is_test)
           VALUES (?, ?, ?, 'PENDING', 1)`,
          ctx.chat.id,
          `TestUser${index}`,
          1
        );
      }
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }

    await ctx.reply(
      `Added ${volume} test transaction${volume === 1 ? '' : 's'} to the queue. ` +
      'Test transactions never perform desktop clicks.'
    );
  });

  bot.action(/^payout-confirm:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Please confirm this payout in a private chat.');
      return;
    }

    const database = await getDatabaseConnection();
    const result = await database.run(
      `UPDATE transaction_queue
       SET recipient_confirmed = 1
       WHERE source_order_id = ? AND chat_id = ? AND username <> ''
         AND status = 'PENDING' AND recipient_confirmed = 0`,
      Number(ctx.match[1]),
      ctx.chat.id
    );

    if (result.changes !== 1) {
      await ctx.reply('This recipient confirmation has expired or was already submitted.');
      return;
    }

    await ctx.reply(
      'Roblox account confirmed. Your paid payout request is queued. ' +
      'Automatic transfers are currently disabled while the transfer engine is being validated.'
    );
  });

  bot.action(/^payout-change:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Please update this payout in a private chat.');
      return;
    }

    const database = await getDatabaseConnection();
    const sourceOrderId = Number(ctx.match[1]);
    const transaction = await database.get(
      `SELECT amount FROM transaction_queue
       WHERE source_order_id = ? AND chat_id = ? AND status = 'PENDING'`,
      sourceOrderId,
      ctx.chat.id
    );
    if (!transaction) {
      await ctx.reply('This payout request is no longer available.');
      return;
    }

    const result = await database.run(
      `UPDATE transaction_queue
       SET username = '', roblox_user_id = NULL, roblox_display_name = NULL,
           recipient_confirmed = 0
       WHERE source_order_id = ? AND chat_id = ? AND status = 'PENDING'`,
      sourceOrderId,
      ctx.chat.id
    );
    if (result.changes !== 1) {
      await ctx.reply('Unable to update this payout request. Please contact support.');
      return;
    }

    const payment = { amount: transaction.amount, sourceOrderId, startedAt: Date.now() };
    const activePayment = activePaymentsByChatId.get(ctx.chat.id);
    if (activePayment && activePayment.sourceOrderId !== sourceOrderId) {
      const pending = pendingPaymentsByChatId.get(ctx.chat.id) ?? [];
      if (!pending.some((entry) => entry.sourceOrderId === sourceOrderId)) {
        pending.push(payment);
        pendingPaymentsByChatId.set(ctx.chat.id, pending);
      }
      await ctx.reply('Your request is saved. You can enter the replacement username when the current request finishes.');
      return;
    }

    activePaymentsByChatId.set(ctx.chat.id, payment);
    await sendActivePrompt(ctx.chat.id, payment);
  });

  bot.on('text', async (ctx, next) => {
    if (ctx.chat.type !== 'private' || ctx.message.text.startsWith('/')) {
      return next();
    }

    const activePayment = activePaymentsByChatId.get(ctx.chat.id);
    if (!activePayment) {
      return next();
    }

    const username = ctx.message.text.trim();
    if (!ROBLOX_USERNAME_PATTERN.test(username)) {
      await ctx.reply('That username is not valid. Send a 3-20 character Roblox username.');
      return;
    }

    let robloxUser;
    try {
      robloxUser = await resolveRobloxUsername(username);
    } catch (error) {
      console.error('Unable to verify Roblox username:', error);
      await ctx.reply('Roblox lookup is temporarily unavailable. Please try again.');
      return;
    }

    if (!robloxUser) {
      await ctx.reply('Roblox username not found. Check the spelling and send the account username again.');
      return;
    }

    try {
      const database = await getDatabaseConnection();
      let result;
      if (activePayment.sourceOrderId === null) {
        result = await database.run(
          `INSERT INTO transaction_queue
            (chat_id, username, amount, status, roblox_user_id, roblox_display_name)
           VALUES (?, ?, ?, 'PENDING', ?, ?)`,
          ctx.chat.id,
          robloxUser.username,
          activePayment.amount,
          robloxUser.id,
          robloxUser.displayName
        );
      } else {
        result = await database.run(
          `UPDATE transaction_queue
           SET username = ?, roblox_user_id = ?, roblox_display_name = ?,
               recipient_confirmed = 0
           WHERE source_order_id = ? AND chat_id = ? AND username = '' AND status = 'PENDING'`,
          robloxUser.username,
          robloxUser.id,
          robloxUser.displayName,
          activePayment.sourceOrderId,
          ctx.chat.id
        );
      }

      if (activePayment.sourceOrderId !== null && result.changes !== 1) {
        throw new Error(`Unable to attach username to order ${activePayment.sourceOrderId}.`);
      }
    } catch (error) {
      console.error('Unable to record payout request:', error);
      await ctx.reply('Unable to record your request right now. Please try again later.');
      return;
    }

    if (activePaymentsByChatId.get(ctx.chat.id) === activePayment) {
      activePaymentsByChatId.delete(ctx.chat.id);
    }
    const keyboard = activePayment.sourceOrderId === null
      ? undefined
      : Markup.inlineKeyboard([
        [Markup.button.callback(
          'Confirm this Roblox account',
          `payout-confirm:${activePayment.sourceOrderId}`
        )],
        [Markup.button.callback(
          'Use a different username',
          `payout-change:${activePayment.sourceOrderId}`
        )]
      ]);
    const message =
      `Roblox account found:\n` +
      `Username: @${robloxUser.username}\n` +
      `Display name: ${robloxUser.displayName}\n` +
      `Payout: ${activePayment.amount} Robux\n\n` +
      'Confirm this is the correct account to queue your paid payout.';
    if (robloxUser.avatarUrl) {
      await ctx.replyWithPhoto(robloxUser.avatarUrl, {
        caption: message,
        ...(keyboard ? { ...keyboard } : {})
      });
    } else {
      await ctx.reply(message, keyboard);
    }
    try {
      await activateNextPrompt(ctx.chat.id);
    } catch (error) {
      console.error(`Unable to send the next payout prompt to chat ${ctx.chat.id}:`, error);
    }
  });

  bot.resumePendingExternalPayments = async () => {
    const database = await getDatabaseConnection();
    const transactions = await database.all(
      `SELECT chat_id, amount, source_order_id
       FROM transaction_queue
       WHERE status = 'PENDING' AND username = '' AND source_order_id IS NOT NULL
       ORDER BY id ASC`
    );

    for (const transaction of transactions) {
      try {
        await bot.handleExternalPayment(
          transaction.chat_id,
          transaction.amount,
          transaction.source_order_id
        );
      } catch (error) {
        console.error(
          `Unable to resume payout prompt for order ${transaction.source_order_id}:`,
          error
        );
      }
    }
  };

  return bot;
}

export function initializeTelegramBot(token) {
  if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
    throw new Error('Set BOT_TOKEN to a valid Telegram bot token before starting.');
  }

  return attachPayoutFlow(new Telegraf(token));
}
