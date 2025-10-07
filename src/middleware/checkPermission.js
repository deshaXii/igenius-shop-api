// src/middleware/checkPermission.js
"use strict";

const { getAuthContext, normalizePerms } = require("../utils/authz");

/**
 * checkPermission(requiredKey, opts?)
 * - requiredKey: اسم الصلاحية (مثال: 'adminOverride' أو 'editRepair' ...الخ)
 * - opts.allowAdmin = true بشكل افتراضي: لو المستخدم أدمن (role=admin) أو adminOverride يمر.
 */
function checkPermission(requiredKey, opts = {}) {
  const { allowAdmin = true } = opts;

  return async function (req, res, next) {
    try {
      const { dbUser, isAdmin, perms } = await getAuthContext(req);

      if (!dbUser) return res.status(401).json({ error: "Unauthorized" });

      // أدمن شامل؟
      if (allowAdmin && isAdmin) return next();

      // لو طالبين صلاحية معينة
      if (requiredKey) {
        const p = normalizePerms(dbUser);
        if (p[requiredKey] === true) return next();
        return res.status(403).json({ error: "Forbidden" });
      }

      // مفيش requiredKey → اعتبر وجود المستخدم كفاية
      return next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = checkPermission;
