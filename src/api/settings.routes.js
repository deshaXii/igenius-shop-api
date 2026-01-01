// src/api/settings.routes.js
"use strict";

const express = require("express");
const router = express.Router();
const Settings = require("../models/Settings.model");
const QRCode = require("qrcode");
const crypto = require("crypto");

const requireAuth = require("../middleware/requireAuth");

router.use(requireAuth);

// إذن الوصول للإعدادات: admin | adminOverride | accessAccounts
function ensureSettingsAccess(req, res, next) {
  const u = req.user || {};
  const p = u.permissions || {};
  if (u.role === "admin" || p.adminOverride === true || p.accessAccounts === true) {
    return next();
  }
  return res.status(403).json({ error: "Forbidden" });
}

/* ---------- Subscription Passcode (ENV) ---------- */
const SUB_PASS = String(process.env.SUBSCRIPTION_ADMIN_PASSCODE || "");
const SUB_PASS_HASH = SUB_PASS
  ? crypto.createHash("sha256").update(SUB_PASS, "utf8").digest()
  : null;

function ensureSubscriptionPasscode(req, res, next) {
  if (!SUB_PASS_HASH) {
    return res.status(500).json({ message: "SUBSCRIPTION_PASSCODE_NOT_CONFIGURED" });
  }

  const provided =
    String(req.get("x-subscription-passcode") || "").trim() ||
    String(req.body?.passcode || "").trim();

  if (!provided) {
    return res.status(401).json({ message: "SUBSCRIPTION_PASSCODE_REQUIRED" });
  }

  const providedHash = crypto.createHash("sha256").update(provided, "utf8").digest();

  // timing safe compare
  const ok =
    providedHash.length === SUB_PASS_HASH.length &&
    crypto.timingSafeEqual(providedHash, SUB_PASS_HASH);

  if (!ok) return res.status(403).json({ message: "INVALID_SUBSCRIPTION_PASSCODE" });

  return next();
}

/* ---------- Helpers ---------- */
async function getSettingsDoc() {
  let s = await Settings.findOne();
  if (!s) {
    s = new Settings();
  }

  // ✅ Default: يبدأ من الغد لمدة سنة لو مش متسجل
  if (!s.subscription || !s.subscription.startAt || !s.subscription.endAt) {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const end = new Date(tomorrow);
    end.setUTCFullYear(end.getUTCFullYear() + 1);

    s.subscription = {
      planName: s.subscription?.planName || "Yearly",
      startAt: s.subscription?.startAt || tomorrow,
      endAt: s.subscription?.endAt || end,
      cycle: "yearly",
    };
  }

  await s.save();
  return s;
}

function parseDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
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

    subscription: {
      planName: s.subscription?.planName || "Yearly",
      startAt: s.subscription?.startAt || null,
      endAt: s.subscription?.endAt || null,
      cycle: s.subscription?.cycle || "yearly",
    },
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

/* ---------- ✅ Update subscription (Protected by ENV passcode) ---------- */
router.put(
  "/subscription",
  ensureSettingsAccess,
  ensureSubscriptionPasscode,
  async (req, res) => {
    const s = await getSettingsDoc();

    const planName = String(req.body.planName || "Yearly").trim() || "Yearly";
    const startAt = parseDateOrNull(req.body.startAt);
    const endAt = parseDateOrNull(req.body.endAt);

    if (!startAt || !endAt) {
      return res.status(400).json({ message: "startAt and endAt are required" });
    }
    if (endAt.getTime() <= startAt.getTime()) {
      return res.status(400).json({ message: "endAt must be after startAt" });
    }

    s.subscription = { planName, startAt, endAt, cycle: "yearly" };
    await s.save();

    return res.json({
      ok: true,
      subscription: {
        planName: s.subscription.planName,
        startAt: s.subscription.startAt,
        endAt: s.subscription.endAt,
        cycle: s.subscription.cycle,
      },
    });
  }
);

/* ---------- Social QR (SVG) ---------- */
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
