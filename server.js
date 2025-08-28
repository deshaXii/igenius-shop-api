// server.js (نسخة retry)
"use strict";
require("dotenv").config();
const http = require("http");
const { scheduleDailyBackup } = require("./src/backup/scheduler");

let app;
try {
  app = require("./src/app");
} catch {
  app = require("./api/index");
}

const attachRealtime = require("./src/realtime/attachRealtime");
const connectDB = require("./src/db/connect");
// ⭐️ أضِف هذا الاستيراد:
const { ensureAdminFromEnv } = require("./src/db/seedAdmin");

const PORT = Number(process.env.PORT) || 5000;
const server = http.createServer(app);

async function start() {
  let attempts = 0;
  while (true) {
    try {
      attempts++;
      await connectDB();

      // ⭐️ أنشئ أدمن افتراضي لو مش موجود
      await ensureAdminFromEnv();

      attachRealtime(server, app);
      server.listen(PORT, () => {
        console.log(`✅ HTTP server on http://localhost:${PORT}`);
        console.log(`✅ Realtime attached at /socket.io`);
      });
      break;
    } catch (err) {
      console.error(`❌ Mongo connect failed (try ${attempts}):`, err.message);
      console.log("↻ retrying in 5s…");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
start();
// بعد ما تتأكد إن الـDB اتوصلت (داخل start() مثلاً):
scheduleDailyBackup();

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
