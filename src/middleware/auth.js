// src/middleware/auth.js
"use strict";

const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

/* نفس مفاتيح الصلاحيات المستخدمة في المشروع */
const PERM_KEYS = [
  "accessAccounts",
  "addRepair",
  "editRepair",
  "deleteRepair",
  "receiveDevice",
  "settings",
  "adminOverride",
];

const toBool = (v) =>
  v === true || v === 1 || v === "1" || v === "true" || v === "on" || v === "yes";

/* تطبيع الصلاحيات + توحيد (إضافة/استلام) + ترقية adminOverride = full allow */
function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);

  // توحيد الاستلام/الإضافة
  if (out.addRepair || out.receiveDevice) {
    out.addRepair = true;
    out.receiveDevice = true;
  }
  // أدمن شامل
  if (out.adminOverride) {
    for (const k of PERM_KEYS) out[k] = true;
  }
  return out;
}

module.exports = async function auth(req, res, next) {
  try {
    // 1) جرّب Authorization: Bearer xxx
    let token = "";
    const hdr = req.headers.authorization || req.headers.Authorization;
    if (hdr && /^Bearer\s+/i.test(hdr)) {
      token = hdr.replace(/^Bearer\s+/i, "").trim();
    }

    // 2) جرّب الكوكي (لو بتستخدمه)
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    // 3) جرّب query ?token=...
    if (!token && req.query && req.query.token) {
      token = String(req.query.token);
    }

    if (!token) return res.status(401).json({ message: "No token provided" });

    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret_change_me"
    );
    const uid = payload.id || payload._id;
    if (!uid) return res.status(401).json({ message: "Invalid token payload" });

    // هات المستخدم كامل (مش lean) علشان لو احتجنا مستقبلاً
    const user = await User.findById(uid)
      .select("role permissions perms isSeedAdmin name username email department password")
      .lean();
    if (!user) return res.status(401).json({ message: "User not found" });

    const perms = normalizePerms(user);

    req.user = {
      id: String(user._id),
      role: user.role,
      name: user.name,
      username: user.username,
      email: user.email,
      department: user.department || null,
      isSeedAdmin: !!user.isSeedAdmin,
      permissions: perms, // ← بعد التطبيع (adminOverride = كل الصلاحيات true)
    };
    next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
