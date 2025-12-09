// src/middleware/requireAuth.js
"use strict";

const jwt = require("jsonwebtoken");
const User = require("../models/User.model");

/* مفاتيح الصلاحيات المعتمدة في المشروع (لازم تشمل settings) */
const PERM_KEYS = [
  "accessAccounts",
  "addRepair",
  "editRepair",
  "deleteRepair",
  "receiveDevice",
  "settings",
  "adminOverride",
];

/* تحويل أي قيمة إلى Boolean مضبوط */
const toBool = (v) =>
  v === true ||
  v === 1 ||
  v === "1" ||
  v === "true" ||
  v === "on" ||
  v === "yes";

/* تطبيع الصلاحيات من (permissions | perms) + تفعيل شامل لو adminOverride */
function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);

  // لو معاه adminOverride، فعّل كل المفاتيح للعرض والتنفيذ
  if (out.adminOverride) {
    for (const k of PERM_KEYS) out[k] = true;
  }
  return out;
}

module.exports = async function requireAuth(req, res, next) {
  try {
    // 1) جرّب Authorization: Bearer xxx
    let token = "";
    const hdr = req.headers.authorization || req.headers.Authorization;
    if (hdr && /^Bearer\s+/i.test(hdr)) {
      token = hdr.replace(/^Bearer\s+/i, "").trim();
    }

    // 2) الكوكي (لو بتستخدمه)
    if (!token && req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    // 3) query ?token=...
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

    // هات المستخدم كامل (بما فيها perms/permissions/isSeedAdmin/department)
    const user = await User.findById(uid)
      .select(
        "role permissions perms isSeedAdmin department name username email"
      )
      .lean();

    if (!user) return res.status(401).json({ message: "User not found" });

    // طبّع الصلاحيات
    let perms = normalizePerms(user);

    // لو هو أدمن أو Seed Admin، فعّل adminOverride واعتبر كل المفاتيح true
    if (user.role === "admin" || user.isSeedAdmin === true) {
      perms.adminOverride = true;
      for (const k of PERM_KEYS) perms[k] = true;
    }

    // إبني req.user الغني بكل ما نحتاجه في الراوترات
    req.user = {
      id: String(user._id),
      _id: String(user._id),
      role: user.role,
      isSeedAdmin: !!user.isSeedAdmin,
      department: user.department || null,
      name: user.name,
      username: user.username,
      email: user.email,
      permissions: perms,
      isAdmin:
        user.role === "admin" ||
        user.isSeedAdmin === true ||
        perms.adminOverride === true,
    };

    next();
  } catch (e) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};
