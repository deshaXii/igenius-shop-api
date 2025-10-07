// src/utils/authz.js
"use strict";

const User = require("../models/User.model");

/** مفاتيح الصلاحيات المعروفة */
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

/** تطبيع الصلاحيات (يوحّد addRepair/receiveDevice) + يفعّل الكل عند adminOverride */
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

/** يجلب المستخدم من الداتابيز ويبنيلك كونتكست صلاحيات موثوق */
async function getAuthContext(req) {
  const base = req.user || {};
  const dbUser = await User.findById(base._id)
    .select("role permissions perms isSeedAdmin department")
    .lean();

  const perms = normalizePerms(dbUser || base || {});
  const isAdmin =
    !!dbUser &&
    (dbUser.role === "admin" || perms.adminOverride === true || base.isAdmin === true);

  const hasIntake = perms.addRepair || perms.receiveDevice;

  return { dbUser, perms, isAdmin, hasIntake };
}

/** اختصار */
const isAdminFrom = (ctxOrUser) => {
  if (!ctxOrUser) return false;
  if (ctxOrUser.isAdmin !== undefined) {
    // ctx
    return !!ctxOrUser.isAdmin;
  }
  // raw user
  const perms = normalizePerms(ctxOrUser);
  return (
    ctxOrUser.role === "admin" ||
    perms.adminOverride === true ||
    ctxOrUser.isAdmin === true
  );
};

module.exports = {
  PERM_KEYS,
  normalizePerms,
  getAuthContext,
  isAdminFrom,
};
