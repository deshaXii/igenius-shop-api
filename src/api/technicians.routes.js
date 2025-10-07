// src/routes/technicians.routes.js
const express = require("express");
const router = express.Router();
const User = require("../models/User.model");
const Repair = require("../models/Repair.model");
const Settings = require("../models/Settings.model");
const requireAuth = require("../middleware/requireAuth");
const checkPermission = require("../middleware/checkPermission");
const calcProfit = require("../utils/calculateProfit");
const bcrypt = require("bcryptjs");
const Department = require("../models/Department.model");

/* ===== Helpers ===== */
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

function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);

  // توحيد الاستلام/الإضافة
  if (out.addRepair || out.receiveDevice) {
    out.addRepair = true;
    out.receiveDevice = true;
  }

  if (out.adminOverride) {
    for (const k of PERM_KEYS) out[k] = true;
  }
  return out;
}

async function getAuthContext(req) {
  const base = req.user || {};
  const dbUser = await User.findById(base._id)
    .select("role permissions perms isSeedAdmin")
    .lean();
  const perms = normalizePerms(dbUser || base || {});

  const isAdmin =
    !!dbUser &&
    (dbUser.role === "admin" || perms.adminOverride === true || base.isAdmin === true);

  const hasIntake = perms.addRepair || perms.receiveDevice;

  return { dbUser, perms, isAdmin, hasIntake };
}

async function isMonitorOf(userId, deptId) {
  const d = await Department.findById(deptId).select("monitor");
  return !!(d && d.monitor && String(d.monitor) === String(userId));
}

router.use(requireAuth);

/* ========== قائمة الفنيين ========== */
// admin أو hasIntake: يرى الكل (قراءة فقط)
// monitor فقط: يرى فنيي قسمه فقط
router.get("/", async (req, res, next) => {
  try {
    const { isAdmin, hasIntake, dbUser } = await getAuthContext(req);

    const { department } = req.query;
    const q = {};

    if (department === "null") q.department = null;
    else if (department) q.department = department;

    if (!(isAdmin || hasIntake)) {
      if (!department) {
        const mine = await Department.findOne({ monitor: dbUser?._id }).select("_id");
        if (!mine) return res.json([]);
        q.department = mine._id;
      }
    }

    const list = await User.find(q)
      .select("name username email phone department permissions perms commissionPct isSeedAdmin")
      .populate("department", "name")
      .lean();

    const withPerms = list.map((t) => ({
      ...t,
      permissions: normalizePerms(t),
    }));

    res.json(withPerms);
  } catch (e) {
    next(e);
  }
});

/* ========== بروفايل الفني ========== */
router.get("/:id/profile", async (req, res, next) => {
  try {
    const techId = req.params.id;
    const tech = await User.findById(techId)
      .select("name commissionPct permissions perms isSeedAdmin")
      .lean();
    if (!tech) return res.status(404).json({ message: "Technician not found" });

    const settings = await Settings.findOne().lean();
    const commissionPct = tech.commissionPct ?? settings?.defaultTechCommissionPct ?? 50;

    const repairs = await Repair.find({ technician: techId }).lean();
    const summary = calcProfit(repairs, { commissionPct });

    res.json({
      tech: {
        ...tech,
        commissionPct,
        permissions: normalizePerms(tech),
      },
      repairsCount: repairs.length,
      summary,
    });
  } catch (e) {
    next(e);
  }
});

/* ========== إنشاء فني جديد (أدمن) ========== */
router.post("/", checkPermission("adminOverride"), async (req, res, next) => {
  try {
    const { name, username, password, commissionPct = 50, permissions } = req.body || {};
    if (!name || !username || !password)
      return res.status(400).json({ message: "بيانات ناقصة" });

    const exists = await User.findOne({ username }).lean();
    if (exists) return res.status(409).json({ message: "اسم المستخدم مستخدم" });

    const normPerms = normalizePerms(permissions || {});
    const u = new User({
      username,
      name,
      password,
      role: "technician",
      commissionPct: Number(commissionPct),
      permissions: normPerms,
      perms: normPerms,
      isSeedAdmin: false,
    });
    await u.save();
    res.json({ ok: true, id: u._id });
  } catch (e) {
    next(e);
  }
});

/* ========== تحديث بيانات وصلاحيات الفني (أدمن) ========== */
router.put("/:id", checkPermission("adminOverride"), async (req, res, next) => {
  try {
    const { name, username, commissionPct, permissions, password } = req.body || {};
    const target = await User.findById(req.params.id).select("permissions perms isSeedAdmin").lean();
    if (!target) return res.status(404).json({ message: "Not found" });

    if (target.isSeedAdmin && !req.user.isSeedAdmin) {
      return res.status(403).json({ message: "لا يمكن تعديل حساب الأدمن الأساسي" });
    }

    const update = {};
    if (typeof name === "string") update.name = name;
    if (typeof username === "string") update.username = username;
    if (typeof commissionPct !== "undefined") update.commissionPct = Number(commissionPct);

    if (permissions && typeof permissions === "object") {
      const merged = { ...normalizePerms(target), ...normalizePerms(permissions) };
      update.permissions = merged;
      update.perms = merged;
    }

    if (password && password.length >= 4) {
      const salt = await bcrypt.genSalt(10);
      update.password = await bcrypt.hash(password, salt);
    }

    update.isSeedAdmin = target.isSeedAdmin;

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    res.json({ ok: true, permissions: normalizePerms(updated) });
  } catch (e) {
    next(e);
  }
});

/* ========== تعيين/إزالة قسم للفني ========== */
router.put("/:id/department", async (req, res, next) => {
  try {
    const { departmentId } = req.body;
    const { isAdmin, dbUser } = await getAuthContext(req);

    // intake لا يغير التعيين — لازم أدمن أو مراقب القسم
    if (!isAdmin) {
      if (!departmentId) return res.status(403).json({ error: "Forbidden" });
      const ok = await isMonitorOf(dbUser?._id, departmentId);
      if (!ok) return res.status(403).json({ error: "Forbidden" });
    }

    const target = await User.findById(req.params.id).select("isSeedAdmin").lean();
    if (!target) return res.status(404).json({ message: "Not found" });

    if (target.isSeedAdmin && !req.user.isSeedAdmin) {
      return res.status(403).json({ message: "لا يمكن تعديل حساب الأدمن الأساسي" });
    }

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { department: departmentId || null } },
      { new: true }
    )
      .select("name username email department permissions perms commissionPct isSeedAdmin")
      .populate("department", "name")
      .lean();

    if (updated) updated.permissions = normalizePerms(updated);

    res.json(updated);
  } catch (e) {
    next(e);
  }
});

/* ========== حذف فني ========== */
router.delete("/:id", checkPermission("adminOverride"), async (req, res, next) => {
  try {
    const target = await User.findById(req.params.id).select("isSeedAdmin").lean();
    if (!target) return res.status(404).json({ message: "Not found" });

    if (target.isSeedAdmin && !req.user.isSeedAdmin) {
      return res.status(403).json({ message: "لا يمكن حذف حساب الأدمن الأساسي" });
    }

    await User.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
