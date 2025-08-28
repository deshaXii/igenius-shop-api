// src/app.js
"use strict";

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");

require("dotenv").config();

const app = express();

// ===== Middleware أساسية =====
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS — عدّل origin حسب بيئة التطوير والإنتاج
const ALLOWED_ORIGINS = [
  "http://localhost:5173", // Vite dev
  "https://mobile-repairs-shop.vercel.app",
  "https://mobile-repairs-shop-api.vercel.app",
  process.env.FRONTEND_ORIGIN, // ضعها في .env للإنتاج
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // للسيرفر-سيرفر/بوستمَان
      return ALLOWED_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error("Not allowed by CORS"));
    },
    credentials: true, // لو هتستخدم كوكيز JWT
  })
);

if (process.env.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ===== Realtime mutation broadcaster (emits :changed) =====
app.use((req, res, next) => {
  const method = req.method.toUpperCase();
  const isMutation =
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE";
  if (!isMutation) return next();

  const urlPath = (req.originalUrl || req.path || "").split("?")[0];
  // نتعامل فقط مع مسارات /api/*
  if (!urlPath.startsWith("/api/")) return next();

  const seg = urlPath.split("/")[2]; // e.g. /api/repairs/123 -> "repairs"
  if (!seg) return next();

  const startedAt = Date.now();
  const actorSocketId =
    req.headers["x-socket-id"] || req.headers["x-socketid"] || null;

  res.on("finish", () => {
    try {
      // إن كانت العملية نجحت
      if (res.statusCode >= 200 && res.statusCode < 400) {
        const io = req.app.get("io");
        if (!io) return;

        const eventName = `${seg}:changed`;
        const payload = {
          path: urlPath,
          method,
          by: actorSocketId || null,
          at: Date.now(),
          tookMs: Date.now() - startedAt,
        };

        if (actorSocketId && io.sockets?.sockets?.get?.(actorSocketId)) {
          // ابعت لكل الناس ماعدا منفّذ العملية
          io.sockets.sockets
            .get(actorSocketId)
            .broadcast.emit(eventName, payload);
        } else {
          // ابعت للجميع
          io.emit(eventName, payload);
        }
      }
    } catch (e) {
      console.warn("[realtime] emit error:", e.message);
    }
  });

  next();
});
// ===== Routes =====
const push = require("./api/push.routes");
app.use("/api/push", push.router);
app.use("/api/auth", require("./api/auth.routes"));
app.use("/api/repairs", require("./api/repairs.routes"));
app.use("/api/technicians", require("./api/technicians.routes"));
app.use("/api/notifications", require("./api/notifications.routes"));
app.use("/api/invoices", require("./api/invoices.routes"));
app.use("/api/settings", require("./api/settings.routes"));
app.use("/api/chat", require("./api/chat.routes"));
app.use("/api/accounts", require("./api/accounts.routes"));
app.use("/api/backup", require("./api/backup.routes"));
app.use("/api/public", require("./api/public.routes"));

// صحة السيرفر
app.get("/health", (req, res) => res.json({ ok: true }));

// 404 افتراضي للـ API
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ message: "Not Found" });
  }
  next();
});

// Error handler بسيط
app.use((err, req, res, next) => {
  console.error("API Error:", err);
  res
    .status(err.status || 500)
    .json({ message: err.message || "Server error" });
});

// مهم: نصدر app فقط — بدون app.listen
module.exports = app;
