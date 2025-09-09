"use strict";
require("dotenv").config();
const http = require("http");

const attachRealtime = require("./src/realtime/attachRealtime");
const connectDB = require("./src/db/connect");
const { scheduleDailyBackup } = require("./src/backup/scheduler");

let app;
try {
  app = require("./src/app");
} catch (e) {
  console.error("Failed to load ./src/app:", e);
  process.exit(1);
}

const PORT = Number(process.env.PORT || 5000);

async function start() {
  // اتصل بقاعدة البيانات مع إعادة المحاولة
  let attempts = 0;
  const max = 5;
  while (attempts < max) {
    attempts++;
    try {
      await connectDB();
      break;
    } catch (err) {
      console.error(`❌ Mongo connect failed (try ${attempts}):`, err.message);
      if (attempts >= max) process.exit(1);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const server = http.createServer(app);
  attachRealtime(server, app);

  server.listen(PORT, () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);
  });

  // جدولة النسخ الاحتياطي اليومي (على سيرفر دائم)
  scheduleDailyBackup();

  process.on("unhandledRejection", (e) => {
    console.error("UnhandledRejection:", e);
  });
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

start();
