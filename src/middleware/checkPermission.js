// module.exports = (permission) => {
//   return (req, res, next) => {
//     const user = req.user;

//     if (
//       user?.role === "admin" ||
//       user?.permissions?.isAdmin ||
//       user?.permissions?.[permission]
//     ) {
//       return next();
//     }

//     return res.status(403).json({ message: "ليس لديك صلاحية" });
//   };
// };

// src/middleware/checkPermission.js
module.exports = function checkPermission(permission) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    if (user.role === "admin") return next();
    const p = user.permissions || {};
    if (p.adminOverride) return next();
    if (permission && p[permission]) return next();

    return res.status(403).json({ message: "Forbidden" });
  };
};
