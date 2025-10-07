// src/api/settings.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const Settings = require("../models/Settings.model");
const User = require("../models/User.model");
const QRCode = require("qrcode");

// ✅ خليك متسق مع بقية المشروع
const requireAuth = require("../middleware/requireAuth");

// لو حابب تسيب checkPermission موجود، ماشي
// بس هنا هنعمل ضمانة أوضح للوصول
// const checkPermission = require("../middleware/checkPermission");

/* ----------------- Middleware ----------------- */
router.use(requireAuth);

// إذن الوصول للإعدادات: admin | adminOverride | accessAccounts
function ensureSettingsAccess(req, res, next) {
  const u = req.user || {};
  const p = (u.permissions || {});
  if (u.role === "admin" || p.adminOverride === true || p.accessAccounts === true) {
    return next();
  }
  return res.status(403).json({ error: "Forbidden" });
}

/* ---------- Helpers ---------- */
async function getSettingsDoc() {
  let s = await Settings.findOne();
  if (!s) {
    s = new Settings();
    await s.save();
  }
  return s;
}

/* ---------- GET settings ---------- */
router.get("/", ensureSettingsAccess, async (req, res) => {
  const s = await getSettingsDoc();
  res.json({
    defaultTechCommissionPct: s.defaultTechCommissionPct,
    phoneNumbers: s.phoneNumbers || [],
    socialLinks: s.socialLinks || [],
    receiptMessage: s.receiptMessage || "",
    receiptFontSizePt: s.receiptFontSizePt,
    receiptPaperWidthMm: s.receiptPaperWidthMm,
    receiptMarginMm: s.receiptMarginMm,
  });
});

/* ---------- Update default commission ---------- */
router.put("/", ensureSettingsAccess, async (req, res) => {
  const pct = Number(req.body.defaultTechCommissionPct);
  if (isNaN(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ message: "Invalid percentage" });
  }
  const s = await getSettingsDoc();
  s.defaultTechCommissionPct = pct;
  await s.save();
  res.json({ ok: true, settings: { defaultTechCommissionPct: pct } });
});

/* ---------- Update phone numbers ---------- */
router.put("/phones", ensureSettingsAccess, async (req, res) => {
  const phones = Array.isArray(req.body.phoneNumbers)
    ? req.body.phoneNumbers.map((p) => String(p).trim()).filter(Boolean)
    : [];
  const s = await getSettingsDoc();
  s.phoneNumbers = phones;
  await s.save();
  res.json({ ok: true, phoneNumbers: s.phoneNumbers });
});

/* ---------- Update social links ---------- */
router.put("/social", ensureSettingsAccess, async (req, res) => {
  const links = Array.isArray(req.body.socialLinks) ? req.body.socialLinks : [];
  const clean = links
    .map((x) => ({
      platform: String(x.platform || "").trim(),
      url: String(x.url || "").trim(),
    }))
    .filter((x) => x.platform && x.url);
  const s = await getSettingsDoc();
  s.socialLinks = clean;
  await s.save();
  res.json({ ok: true, socialLinks: s.socialLinks });
});

/* ---------- Update receipt settings ---------- */
router.put("/receipt", ensureSettingsAccess, async (req, res) => {
  const s = await getSettingsDoc();
  const {
    receiptMessage = "",
    receiptFontSizePt,
    receiptPaperWidthMm,
    receiptMarginMm,
  } = req.body || {};

  if (typeof receiptMessage === "string") s.receiptMessage = receiptMessage;

  if (typeof receiptFontSizePt !== "undefined" && !isNaN(Number(receiptFontSizePt))) {
    const v = Number(receiptFontSizePt);
    if (v >= 8 && v <= 24) s.receiptFontSizePt = v;
  }
  if (typeof receiptPaperWidthMm !== "undefined" && !isNaN(Number(receiptPaperWidthMm))) {
    const v = Number(receiptPaperWidthMm);
    if (v >= 40 && v <= 120) s.receiptPaperWidthMm = v;
  }
  if (typeof receiptMarginMm !== "undefined" && !isNaN(Number(receiptMarginMm))) {
    const v = Number(receiptMarginMm);
    if (v >= 0 && v <= 20) s.receiptMarginMm = v;
  }

  await s.save();
  res.json({
    ok: true,
    receipt: {
      receiptMessage: s.receiptMessage,
      receiptFontSizePt: s.receiptFontSizePt,
      receiptPaperWidthMm: s.receiptPaperWidthMm,
      receiptMarginMm: s.receiptMarginMm,
    },
  });
});

/* ---------- Social QR (SVG) ---------- */
/**
 * ملحوظة مهمة:
 * الاندبوينت ده بيرجع صورة SVG، وأغلب المشاريع عاملة Interceptor
 * يعمل Log out عند أي 401. عشان نتجنّب خروج المستخدم لو الصورة فشلت،
 * هنسمح بالـ token من الكويري `?token=` برضه (auth middleware بتاعك بيدعمه).
 *
 * وكمان نمرره بنفس ensureSettingsAccess عشان مايبقاش مفتوح.
 */
router.get("/social/:idx/qr.svg", ensureSettingsAccess, async (req, res) => {
  const idx = Number(req.params.idx);
  const s = await getSettingsDoc();
  const links = s.socialLinks || [];
  if (isNaN(idx) || idx < 0 || idx >= links.length) {
    return res.status(404).end();
  }
  const url = links[idx].url;
  res.setHeader("Content-Type", "image/svg+xml");
  const svg = await QRCode.toString(url, { type: "svg", margin: 0, width: 256 });
  return res.send(svg);
});

module.exports = router;
