"use strict";

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { requestId } = require("./middleware/requestId");

require("dotenv").config();

const app = express();

// --- أمان وأساسيات
app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(cookieParser());
app.use(requestId);
// CORS ذكي من ENV
const ALLOWED = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Rate limit أساسي
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

// منع الكاش على /api
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// --- Mount routes
app.use("/api/auth", require("./api/auth.routes"));
app.use("/api/repairs", require("./api/repairs.routes"));
app.use("/api/technicians", require("./api/technicians.routes"));
app.use("/api/accounts", require("./api/accounts.routes"));
app.use("/api/invoices", require("./api/invoices.routes"));
app.use("/api/parts", require("./api/parts.routes"));
app.use("/api/notifications", require("./api/notifications.routes"));
app.use("/api/push", require("./api/push.routes").router);
app.use("/api/backup", require("./api/backup.routes"));
app.use("/api/logs", require("./api/logs.routes"));
app.use("/api/public", require("./api/public.routes"));
app.use("/api/settings", require("./api/settings.routes"));
app.use("/api/departments", require("./api/departments.routes"));
app.use("/api/suppliers", require("./api/suppliers.routes"));
app.use("/api/inventory", require("./api/inventory.routes"));

// Error handler
app.use((err, req, res, next) => {
  console.error("API Error:", err);
  res.status(err.status || 500).json({
    error: "InternalError",
    message: err.message || "Server error",
    requestId: req.id || null,
  });
});

module.exports = app;
