// src/api/backup.routes.js
"use strict";
const express = require("express");
const auth = require("../middleware/auth.js");
const checkAdmin = require("../middleware/checkAdmin.js");
const path = require("path");
const fs = require("fs");

const multer = require("multer");

const {
  backupToBuffer,
  runBackupNow,
  readLastMeta,
  getDbStats,
  BACKUP_DIR,
  restoreFromBackupBuffer,
} = require("../backup/backupService.js");

const router = express.Router();

// Upload in-memory (ملف صغير)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.BACKUP_MAX_UPLOAD_MB || 50) * 1024 * 1024,
  },
});

router.post("/run-download", auth, checkAdmin, async (req, res) => {
  try {
    const { buffer, filename, mime } = await backupToBuffer();
    res.setHeader("Content-Type", mime || "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    console.error("[backup/run-download] error:", e);
    res.status(500).json({ message: "فشل في إنشاء/تنزيل النسخة الاحتياطية" });
  }
});

// Restore: ارفع ملف backup واسترجعه
router.post(
  "/restore",
  auth,
  checkAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "اختر ملف النسخة الاحتياطية" });
      }

      const replace =
        String(req.body?.replace || "1") === "1" ||
        String(req.body?.replace || "").toLowerCase() === "true";

      const r = await restoreFromBackupBuffer(req.file.buffer, req.file.originalname, {
        replace,
      });

      res.json(r);
    } catch (e) {
      console.error("[backup/restore] error:", e);
      res.status(500).json({ message: "فشل استعادة النسخة الاحتياطية" });
    }
  }
);

// تشغيل النسخ الآن:
// 1) إداري Auth + Admin
// 2) أو عبر كرون سيكرت: GET/POST /api/backup/run?secret=YOUR_SECRET
router.all(
  "/run",
  async (req, res, next) => {
    const cronSecret = req.query.secret || req.get("x-cron-secret");
    if (cronSecret && cronSecret === process.env.BACKUP_CRON_SECRET) {
      try {
        const r = await runBackupNow();
        return res.json(r);
      } catch (e) {
        console.error("[backup/run] cron error:", e);
        return res
          .status(500)
          .json({ message: "فشل في أخذ النسخة الاحتياطية" });
      }
    }
    return next();
  },
  auth,
  checkAdmin,
  async (req, res) => {
    try {
      const r = await runBackupNow();
      res.json(r);
    } catch (e) {
      console.error("[backup/run] error:", e);
      res.status(500).json({ message: "فشل في أخذ النسخة الاحتياطية" });
    }
  }
);

// آخر نسخة
router.get("/last", auth, checkAdmin, async (req, res) => {
  try {
    const meta = await readLastMeta();
    res.json(meta);
  } catch (e) {
    res.status(500).json({ message: "تعذر جلب آخر نسخة" });
  }
});

// إحصائيات الحجم + آخر نسخة
router.get("/stats", auth, checkAdmin, async (req, res) => {
  try {
    const stats = await getDbStats();
    const meta = await readLastMeta();
    res.json({
      ...stats,
      lastBackupAt: meta.lastBackupAt || null,
      latestFile: meta.fileKey || null,
      latestFileSizeMB: meta.fileSize
        ? Math.round((meta.fileSize / (1024 * 1024)) * 100) / 100
        : null,
      storage: meta.storage || "none",
      method: meta.method || null,
    });
  } catch (e) {
    console.error("[backup/stats] error:", e);
    res.status(500).json({ message: "فشل في جلب إحصائيات النسخ الاحتياطي" });
  }
});

// تنزيل ملف محلي (لو بتشتغل على لوكل فقط)
router.get("/download/:file", auth, checkAdmin, (req, res) => {
  const file = req.params.file;
  if (!/^[\w.\-]+$/.test(file))
    return res.status(400).json({ message: "اسم ملف غير صالح" });

  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full))
    return res
      .status(404)
      .json({ message: "الملف غير موجود (قد يكون رُفع للتخزين الخارجي)" });

  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  fs.createReadStream(full).pipe(res);
});

module.exports = router;
