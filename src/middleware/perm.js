"use strict";

function isAdmin(req) {
  return req.user?.role === "admin" || req.user?.permissions?.adminOverride;
}

// hasPerm("accounts") => (req) => true/false
function hasPerm(key) {
  return (req) => !!req.user?.permissions?.[key];
}

function requireAny(...checks) {
  return (req, res, next) => {
    try {
      if (checks.some((fn) => !!fn(req))) return next();
      return res
        .status(403)
        .json({ message: "ليس لديك صلاحية لتنفيذ هذا الإجراء" });
    } catch {
      return res.status(403).json({ message: "ليس لديك صلاحية" });
    }
  };
}

module.exports = { isAdmin, hasPerm, requireAny };
