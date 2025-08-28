// src/backup/scheduler.js
"use strict";
const cron = require("node-cron");
const { runBackupNow } = require("./backupService");

function scheduleDailyBackup() {
  // 23:59 كل يوم بتوقيت القاهرة
  cron.schedule(
    "59 23 * * *",
    async () => {
      try {
        console.log("[backup] Running scheduled daily backup…");
        const r = await runBackupNow();
        console.log("[backup] Completed:", r.file, "at", r.at);
      } catch (e) {
        console.error("[backup] Scheduled backup failed:", e);
      }
    },
    { timezone: "Africa/Cairo" }
  );
}

module.exports = { scheduleDailyBackup };
