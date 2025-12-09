// src/middleware/checkPermission.js
"use strict";

const { normalizePerms } = require("../utils/authz");

/**
 * checkPermission(requiredKey, opts?)
 * - requiredKey: اسم الصلاحية (مثال: 'adminOverride' أو 'editRepair' ...الخ)
 * - opts.allowAdmin = true بشكل افتراضي: لو المستخدم أدمن (role=admin) أو عنده adminOverride يمر.
 *
 * ملاحظة مهمة:
 * لازم middleware الـ auth يشتغل قبل checkPermission في كل الراوتات
 * عشان يملأ req.user.
 */
function checkPermission(requiredKey, opts = {}) {
  const { allowAdmin = true } = opts;

  return function (req, res, next) {
    try {
      const dbUser = req.user; // جاي من auth middleware

      if (!dbUser) {
        console.log(
          "[checkPermission] no req.user → 401",
          requiredKey,
          req.method,
          req.originalUrl
        );
        return res.status(401).json({ error: "Unauthorized" });
      }

      const perms = normalizePerms(dbUser) || {};

      const isAdmin =
        allowAdmin && (dbUser.role === "admin" || perms.adminOverride === true);

      if (isAdmin) {
        return next();
      }

      // لو طالبين صلاحية معيّنة (زي editRepair)
      if (requiredKey) {
        if (perms[requiredKey] === true) {
          return next();
        }

        console.log(
          "[checkPermission] Forbidden – missing perm",
          requiredKey,
          "for user",
          String(dbUser._id || dbUser.id || "")
        );
        return res.status(403).json({ error: "Forbidden" });
      }

      // مفيش requiredKey → مجرد وجود المستخدم كفاية
      return next();
    } catch (e) {
      console.error("[checkPermission] error:", e);
      return res.status(500).json({ error: "Server error" });
    }
  };
}

module.exports = checkPermission;
