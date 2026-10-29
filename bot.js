import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import { Markup, Telegraf } from "telegraf";
import { attachPayoutFlow } from "./roblox-payout-bot/src/telegram.js";
import { deployMacroProcessingLoop } from "./roblox-payout-bot/src/macro.js";
import { closeDatabaseConnection } from "./roblox-payout-bot/src/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new Database(path.join(__dirname, "store.db"));

db.pragma("journal_mode = WAL");
db.prepare(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id INTEGER NOT NULL,
    product_id TEXT NOT NULL,
    product_title TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount INTEGER NOT NULL,
    invoice_payload TEXT NOT NULL,
    payment_charge_id TEXT,
    order_status TEXT NOT NULL DEFAULT 'paid',
    order_info TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice_payload ON orders(invoice_payload)`,
).run();

const PRODUCTS = {
  robux25: {
    id: "robux25",
    title: "25 Robux",
    description: "Roblox payout of 25 Robux.",
    currency: "USD",
    amount: 49,
    displayPrice: "$0.49 USD",
    robuxAmount: 25,
    physical: false,
  },
  robux50: {
    id: "robux50",
    title: "50 Robux",
    description: "Roblox payout of 50 Robux.",
    currency: "USD",
    amount: 99,
    displayPrice: "$0.99 USD",
    robuxAmount: 50,
    physical: false,
  },
  robux100: {
    id: "robux100",
    title: "100 Robux",
    description: "Roblox payout of 100 Robux.",
    currency: "USD",
    amount: 199,
    displayPrice: "$1.99 USD",
    robuxAmount: 100,
    physical: false,
  },
  robux250: {
    id: "robux250",
    title: "250 Robux",
    description: "Roblox payout of 250 Robux.",
    currency: "USD",
    amount: 499,
    displayPrice: "$4.99 USD",
    robuxAmount: 250,
    physical: false,
  },
  robux500: {
    id: "robux500",
    title: "500 Robux",
    description: "Roblox payout of 500 Robux.",
    currency: "USD",
    amount: 999,
    displayPrice: "$9.99 USD",
    robuxAmount: 500,
    physical: false,
  },
  robux1000: {
    id: "robux1000",
    title: "1,000 Robux",
    description: "Roblox payout of 1,000 Robux.",
    currency: "USD",
    amount: 1999,
    displayPrice: "$19.99 USD",
    robuxAmount: 1000,
    physical: false,
  },
};

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function abaConfig() {
  return {
    apiKey: requiredEnvironment("ABA_API_KEY"),
    apiSecret: process.env.ABA_API_SECRET?.trim() || "",
    baseUrl: process.env.ABA_BASE_URL?.trim() || "https://paylinkapi-bot.onrender.com",
  };
}

// Keep Render API awake to prevent cold start delays (which take 30-50s on sleep)
function keepGatewayWarm() {
  try {
    const config = abaConfig();
    const baseUrl = config.baseUrl.replace(/\/$/, "");
    // Immediate ping
    fetch(baseUrl).catch(() => {});
    // Recurring ping every 8 minutes
    return setInterval(() => {
      fetch(baseUrl).catch(() => {});
    }, 8 * 60 * 1000);
  } catch {
    return undefined;
  }
}

function validateDeliveryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DIGITAL_DELIVERY_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("DIGITAL_DELIVERY_URL must be a valid HTTPS URL.");
  }
  return value;
}

function invoicePayload(product, userId) {
  return `store:${product.id}:${userId}:${Date.now()}`;
}

function calculateCrc16(value) {
  let crc = 0xffff;
  for (const character of value) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function isValidKhqrPayload(value) {
  if (!value.startsWith("000201") || !/6304[0-9A-Fa-f]{4}$/.test(value)) {
    return false;
  }
  return calculateCrc16(value.slice(0, -4)) === value.slice(-4).toUpperCase();
}

// Generate a provider-backed dynamic KHQR with a strict timeout.
async function createAbaKhqr(product, userId) {
  const config = abaConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const amountInDollars = Number((product.amount / 100).toFixed(2));

  // Allow the payment provider time to wake from a cold start.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${baseUrl}/api/aba/generate-qr`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        amount: amountInDollars,
        currency: product.currency || "USD",
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const tranId = data.tranId || data.transactionId;
    if (
      !data.success ||
      typeof data.qrString !== "string" ||
      !data.qrString.trim() ||
      !tranId
    ) {
      throw new Error(data.error || "Provider response is missing its QR payload or transaction ID.");
    }

    const qrValue = data.qrString.trim();
    if (
      qrValue.startsWith("000201") &&
      !isValidKhqrPayload(qrValue)
    ) {
      throw new Error("Payment provider returned a KHQR payload with an invalid checksum.");
    }

    return {
      qrValue,
      tranId,
      deepLink: data.deepLink || data.deeplink,
      bank: data.bank || "ABA Bank",
      merchantLink: data.merchantLink,
      metadata: data,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Payment provider QR request timed out after 20 seconds.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Check real-time payment status from PaylinkApi
async function checkPaymentStatus(tranId) {
  const config = abaConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/payment/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({ tranId }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
}

// Optimized fast PNG QR image buffer generation (smaller size = faster transfer)
async function createQrBuffer(value) {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.*)$/i.exec(value);
    if (!match) {
      throw new Error("Payment provider returned a malformed QR image.");
    }
    const image = Buffer.from(match[1], "base64");
    if (image.length === 0) {
      throw new Error("Payment provider returned an empty QR image.");
    }
    return image;
  }

  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) {
      throw new Error(`QR image request failed with HTTP ${response.status}.`);
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/")) {
      throw new Error("QR image URL did not return an image.");
    }
    const image = Buffer.from(await response.arrayBuffer());
    if (image.length === 0) {
      throw new Error("Payment provider returned an empty QR image.");
    }
    return image;
  }

  if (!isValidKhqrPayload(String(value))) {
    throw new Error("Payment provider returned an unsupported or invalid KHQR payload.");
  }

  return QRCode.toBuffer(String(value), {
    type: "image/png",
    margin: 1,
    width: 360,
    errorCorrectionLevel: "M",
  });
}

function productFromPayload(payload) {
  const match = /^store:(robux25|robux50|robux100|robux250|robux500|robux1000):(\d+):(\d+)$/.exec(payload);
  if (!match) {
    return null;
  }
  return {
    product: PRODUCTS[match[1]],
    userId: Number(match[2]),
    nonce: Number(match[3]),
  };
}

function saveOrder({ telegramUserId, product, payment, orderInfo, orderStatus = "paid" }) {
  const existing = db
    .prepare("SELECT id FROM orders WHERE invoice_payload = ?")
    .get(payment.invoice_payload);

  if (existing) {
    return existing.id;
  }

  const insert = db.prepare(`
    INSERT INTO orders (
      telegram_user_id,
      product_id,
      product_title,
      currency,
      amount,
      invoice_payload,
      payment_charge_id,
      order_status,
      order_info
    ) VALUES (
      @telegram_user_id,
      @product_id,
      @product_title,
      @currency,
      @amount,
      @invoice_payload,
      @payment_charge_id,
      @order_status,
      @order_info
    )
  `);

  const result = insert.run({
    telegram_user_id: telegramUserId,
    product_id: product.id,
    product_title: product.title,
    currency: product.currency,
    amount: product.amount,
    invoice_payload: payment.invoice_payload,
    payment_charge_id: payment.telegram_payment_charge_id,
    order_status: orderStatus,
    order_info: orderInfo ? JSON.stringify(orderInfo) : null,
  });

  return result.lastInsertRowid;
}

async function enqueuePaidRobuxOrder(bot, orderId) {
  const order = db
    .prepare("SELECT id, telegram_user_id, product_id, amount, order_status FROM orders WHERE id = ?")
    .get(orderId);
  if (!order || order.order_status !== "paid") {
    return;
  }

  const product = PRODUCTS[order.product_id];
  if (!product?.robuxAmount) {
    return;
  }
  if (order.amount !== product.amount) {
    console.error(`Paid order ${order.id} does not match the current price for ${product.id}.`);
    return;
  }

  try {
    await bot.handleExternalPayment(
      order.telegram_user_id,
      product.robuxAmount,
      order.id
    );
  } catch (error) {
    console.error(`Unable to start payout intake for paid order ${order.id}:`, error);
  }
}

async function resumePaidRobuxOrders(bot) {
  const paidOrders = db
    .prepare("SELECT id FROM orders WHERE order_status = 'paid' ORDER BY id")
    .all();

  for (const order of paidOrders) {
    await enqueuePaidRobuxOrder(bot, order.id);
  }
}

// Background poller map
const activePollers = new Map();

function startPaymentPolling(bot, chatId, orderId, tranId, productTitle, displayPrice) {
  if (!tranId || String(tranId).startsWith("KHQR_")) return;
  if (activePollers.has(orderId)) {
    clearInterval(activePollers.get(orderId));
  }

  let attempts = 0;
  const maxAttempts = 60; // 5 seconds * 60 = 5 minutes
  const timer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(timer);
      activePollers.delete(orderId);
      return;
    }

    try {
      const order = db.prepare("SELECT order_status FROM orders WHERE id = ?").get(orderId);
      if (!order || order.order_status === "paid") {
        clearInterval(timer);
        activePollers.delete(orderId);
        return;
      }

      const status = await checkPaymentStatus(tranId);
      if (status.paid || status.status === "PAID") {
        clearInterval(timer);
        activePollers.delete(orderId);

        db.prepare("UPDATE orders SET order_status = 'paid' WHERE id = ?").run(orderId);

        await bot.telegram.sendMessage(
          chatId,
          `🎉 *Payment Received & Confirmed!*\n\n` +
          `Your payment for *${productTitle}* (${displayPrice}) was successfully verified via ABA PayWay.\n` +
          `Transaction ID: \`${tranId}\`\n\n` +
          `Thank you for your purchase! We are now preparing your order.`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("🛍 Browse More Products", "catalog")],
            ]),
          }
        );
        await enqueuePaidRobuxOrder(bot, orderId);
      }
    } catch {
      // transient network error, keep polling
    }
  }, 5000);

  activePollers.set(orderId, timer);
}

function catalogKeyboard() {
  const rows = Object.values(PRODUCTS).map((product) => [
    Markup.button.callback(
      `${product.title} — ${product.displayPrice}`,
      `buy:${product.id}`,
    ),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function showCatalog(ctx) {
  await ctx.reply(
    "Welcome! Choose a Robux payout amount to continue to secure checkout:",
    catalogKeyboard(),
  );
}

async function openProduct(ctx, bot) {
  // Instant visual feedback so user immediately knows button was registered
  ctx.answerCbQuery("⚡ Generating QR code...").catch(() => {});

  const productId = ctx.callbackQuery.data.slice("buy:".length);
  const product = PRODUCTS[productId];
  if (!product) {
    await ctx.editMessageText("That product is no longer available.");
    return;
  }

  // Display immediate loading state (no blank screens)
  await ctx.editMessageText(`⏳ *Generating secure ABA KHQR code for ${product.title}...*`, {
    parse_mode: "Markdown",
  }).catch(() => {});

  const orderPayload = invoicePayload(product, ctx.from.id);
  let payment;

  try {
    payment = await createAbaKhqr(product, ctx.from.id);
  } catch (error) {
    console.error("Payment provider could not create a valid QR:", error);
    await ctx.editMessageText(
      "I couldn't get a verifiable payment QR right now. Please don't use an earlier QR; try again later."
    );
    return;
  }

  const { qrValue: qrText, tranId, deepLink, bank: bankName, metadata } = payment;
  let qrBuffer;
  try {
    qrBuffer = await createQrBuffer(qrText);
  } catch (error) {
    console.error("Could not render the payment provider QR:", error);
    await ctx.editMessageText(
      "The payment provider returned a QR that couldn't be verified and displayed. Please don't use an earlier QR; try again later."
    );
    return;
  }

  const orderId = saveOrder({
    telegramUserId: ctx.from.id,
    product,
    payment: {
      invoice_payload: orderPayload,
      telegram_payment_charge_id: tranId,
    },
    orderStatus: "pending",
    orderInfo: {
      tranId,
      deepLink,
      paymentMethod: "KHQR",
      bank: bankName,
      merchant: metadata?.merchantId || process.env.KHQR_MERCHANT_NAME || "ROBUX PAYOUT STORE",
      apiSource: "aba",
      amountFormatted: product.displayPrice,
    },
  });

  const buttons = [];
  const config = abaConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  buttons.push([
    Markup.button.url(
      "📲 Open in ABA Mobile",
      `${baseUrl}/api/aba/open/${tranId}`
    ),
  ]);

  buttons.push([
    Markup.button.callback("🔄 Check Payment Status", `check:${orderId}`),
  ]);
  buttons.push([
    Markup.button.callback("« Back to Catalog", "catalog"),
  ]);

  const caption =
    `💳 *${product.title}*\n` +
    `💰 Price: *${product.displayPrice}*\n` +
    `🏦 Payment: *${bankName} KHQR*\n` +
    `🧾 Order ID: \`#${orderId}\`\n\n` +
    `👉 *Scan this KHQR with ABA Mobile or any Bakong banking app* to pay.\n` +
    `Or tap *Open in ABA Mobile* below to launch your banking app directly.\n\n` +
    `_Your payment will be automatically verified once completed!_`;

  // Remove the temporary loading message
  try {
    await ctx.deleteMessage();
  } catch {}

  await ctx.replyWithPhoto(
    { source: qrBuffer, filename: `${product.id}-khqr.png` },
    {
      caption,
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    }
  );

  startPaymentPolling(
    bot,
    ctx.chat.id,
    orderId,
    tranId,
    product.title,
    product.displayPrice
  );
}

async function handleCheckPayment(ctx, bot) {
  const orderId = Number(ctx.match[1]);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order) {
    await ctx.answerCbQuery("Order not found.", { show_alert: true });
    return;
  }

  if (order.order_status === "paid") {
    await ctx.answerCbQuery("✅ Payment is already confirmed!", { show_alert: true });
    return;
  }

  let info = {};
  try {
    info = order.order_info ? JSON.parse(order.order_info) : {};
  } catch {}

  const tranId = info.tranId || order.payment_charge_id;
  if (!tranId) {
    await ctx.answerCbQuery("This order has no payment provider transaction ID and needs manual review.", { show_alert: true });
    return;
  }

  await ctx.answerCbQuery("Checking payment status...");

  try {
    const status = await checkPaymentStatus(tranId);
    if (status.paid || status.status === "PAID") {
      db.prepare("UPDATE orders SET order_status = 'paid' WHERE id = ?").run(orderId);
      const successText =
        `🎉 *Payment Confirmed!*\n\n` +
        `Product: *${order.product_title}*\n` +
        `Amount: *$${(order.amount / 100).toFixed(2)} USD*\n` +
        `Transaction ID: \`${tranId}\`\n` +
        `Status: *PAID (ABA Bank)*\n\n` +
        `Thank you for your purchase! We are now processing your order.`;

      try {
        await ctx.editMessageCaption(successText, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🛍 Browse More Products", "catalog")],
          ]),
        });
      } catch {
        await ctx.reply(successText, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🛍 Browse More Products", "catalog")],
          ]),
        });
      }
      await enqueuePaidRobuxOrder(bot, orderId);
    } else {
      await ctx.reply(
        `⏳ Payment is still pending for order #${orderId}.\n\nIf you have already paid in ABA Mobile, please wait a few seconds and tap "Check Payment Status" again.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔄 Re-check Payment", `check:${orderId}`)],
          [Markup.button.callback("« Back to Catalog", "catalog")],
        ])
      );
    }
  } catch (error) {
    console.error("Failed to check payment status:", error.message);
    await ctx.reply("Could not verify payment status right now. If you completed payment, send a screenshot of the receipt here.");
  }
}

async function handleUserPhoto(ctx, bot) {
  const userId = ctx.from.id;
  const recentOrder = db
    .prepare(
      "SELECT * FROM orders WHERE telegram_user_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(userId);

  if (recentOrder) {
    let info = {};
    try {
      info = recentOrder.order_info ? JSON.parse(recentOrder.order_info) : {};
    } catch {}

    const tranId = info.tranId || recentOrder.payment_charge_id;
    if (tranId && !String(tranId).startsWith("KHQR_")) {
      try {
        const status = await checkPaymentStatus(tranId);
        if (status.paid || status.status === "PAID") {
          db.prepare("UPDATE orders SET order_status = 'paid' WHERE id = ?").run(recentOrder.id);
          await ctx.reply(
            `🎉 Payment receipt received and verified!\nYour payment for ${recentOrder.product_title} has been confirmed. Thank you!`,
            Markup.inlineKeyboard([
              [Markup.button.callback("🛍 Browse More Products", "catalog")],
            ])
          );
          await enqueuePaidRobuxOrder(bot, recentOrder.id);
          return;
        }
      } catch {}
    }

    await ctx.reply(
      `📷 Receipt received for order #${recentOrder.id} (${recentOrder.product_title})!\nThe store team will verify your transfer. Payout starts only after payment is confirmed.`
    );
  } else {
    await ctx.reply(
      "Thank you for sending your photo. Browse /catalog to choose a Robux payout amount."
    );
  }
}

async function handlePreCheckout(ctx) {
  const query = ctx.preCheckoutQuery;
  const parsed = productFromPayload(query.invoice_payload);

  if (!parsed) {
    await ctx.answerPreCheckoutQuery(
      false,
      "This invoice is invalid. Please start again.",
    );
    return;
  }

  const { product, userId } = parsed;
  if (
    query.from.id !== userId ||
    query.currency !== product.currency ||
    query.total_amount !== product.amount
  ) {
    await ctx.answerPreCheckoutQuery(
      false,
      "The invoice details could not be verified. Please start again.",
    );
    return;
  }

  if (
    product.physical &&
    (!query.order_info?.name ||
      !query.order_info?.email ||
      !query.order_info?.shipping_address)
  ) {
    await ctx.answerPreCheckoutQuery(
      false,
      "Please provide your name, email, and shipping address.",
    );
    return;
  }

  await ctx.answerPreCheckoutQuery(true);
}

async function handleSuccessfulPayment(ctx, bot) {
  const payment = ctx.message.successful_payment;
  if (!payment) {
    return;
  }

  const parsed = productFromPayload(payment.invoice_payload);
  if (!parsed) {
    console.error("Successful payment has an unrecognized invoice payload.");
    await ctx.reply(
      "Your payment was received, but we could not identify the order. Please contact the store.",
    );
    return;
  }

  const { product, userId } = parsed;
  if (
    ctx.from.id !== userId ||
    payment.currency !== product.currency ||
    payment.total_amount !== product.amount
  ) {
    console.error(
      `Payment verification failed for Telegram charge ${payment.telegram_payment_charge_id}.`,
    );
    await ctx.reply(
      "Your payment was received, but the order needs manual review. Please contact the store.",
    );
    return;
  }

  const orderId = saveOrder({
    telegramUserId: userId,
    product,
    payment,
    orderInfo: payment.order_info,
    orderStatus: "paid",
  });

  if (!product.physical) {
    await ctx.reply(
      "Thank you for your purchase! Your Robux payout request is being prepared."
    );
    await enqueuePaidRobuxOrder(bot, orderId);
    console.info(
      `Stored order ${orderId} for ${product.id}; delivered to Telegram user ${userId}; charge ${payment.telegram_payment_charge_id}.`,
    );
    return;
  }

  const orderInfo = payment.order_info;
  const address = orderInfo?.shipping_address;
  if (!orderInfo?.name || !orderInfo?.email || !address) {
    console.error(
      `Physical payment ${payment.telegram_payment_charge_id} has incomplete order details; manual follow-up required.`,
    );
    await ctx.reply(
      "Thank you for your payment. We need to verify your shipping details before dispatch; the store will contact you.",
    );
    return;
  }

  console.info("Physical order received", {
    orderId,
    product: product.id,
    telegramUserId: userId,
    name: orderInfo.name,
    email: orderInfo.email,
    shippingAddress: address,
    telegramPaymentChargeId: payment.telegram_payment_charge_id,
  });
  await ctx.reply(
    "Thank you for your purchase! Your payment was successful. We have received your shipping details and will prepare your order.",
  );
}

async function main() {
  const botToken = requiredEnvironment("BOT_TOKEN");
  const bot = new Telegraf(botToken);
  attachPayoutFlow(bot);
  const payoutShutdownController = new AbortController();
  let payoutWorkerPromise;
  const gatewayWarmTimer = keepGatewayWarm();

  const shutdown = async (signalName) => {
    for (const timer of activePollers.values()) clearInterval(timer);
    if (gatewayWarmTimer) clearInterval(gatewayWarmTimer);
    payoutShutdownController.abort();
    bot.stop(signalName);

    try {
      if (payoutWorkerPromise) {
        await payoutWorkerPromise;
      }
    } catch (error) {
      console.error("Payout worker stopped during shutdown:", error);
      process.exitCode = 1;
    }

    try {
      await closeDatabaseConnection();
    } catch (error) {
      console.error("Could not close the payout queue database:", error);
      process.exitCode = 1;
    }
  };

  bot.command("start", showCatalog);
  bot.command("catalog", showCatalog);
  bot.action("catalog", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
    await showCatalog(ctx);
  });
  bot.action(/^buy:(robux25|robux50|robux100|robux250|robux500|robux1000)$/, (ctx) =>
    openProduct(ctx, bot),
  );
  bot.action(/^check:(\d+)$/, (ctx) => handleCheckPayment(ctx, bot));
  bot.on("pre_checkout_query", handlePreCheckout);
  bot.on("message", async (ctx) => {
    if (ctx.message?.successful_payment) {
      await handleSuccessfulPayment(ctx, bot);
    } else if (ctx.message?.photo) {
      await handleUserPhoto(ctx, bot);
    }
  });

  bot.catch((error, ctx) => {
    console.error(
      `Unhandled bot error while processing update ${ctx.update.update_id}:`,
      error,
    );
  });

  process.once("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("Could not shut down cleanly:", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("Could not shut down cleanly:", error);
      process.exitCode = 1;
    });
  });

  await bot.launch();
  console.info("Telegram store bot is running.");
  await resumePaidRobuxOrders(bot);
  await bot.resumePendingExternalPayments();
  if (payoutShutdownController.signal.aborted) {
    await closeDatabaseConnection();
    return;
  }
  payoutWorkerPromise = deployMacroProcessingLoop(bot, {
    signal: payoutShutdownController.signal
  });
  payoutWorkerPromise.catch((error) => {
    console.error("Payout worker stopped unexpectedly:", error);
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error("Could not start the Telegram store bot:", error.message);
  process.exitCode = 1;
});
