const express = require("express");
const router = express.Router();
const User = require("../models/User.model");
const Repair = require("../models/Repair.model");
const Settings = require("../models/Settings.model");
const auth = require("../middleware/auth");
const checkPermission = require("../middleware/checkPermission");
const calcProfit = require("../utils/calculateProfit");
const bcrypt = require("bcryptjs");

router.use(auth);

// مفاتيح الصلاحيات المعتمدة في الواجهة
const PERM_KEYS = [
  "accessAccounts",
  "addRepair",
  "editRepair",
  "deleteRepair",
  "receiveDevice",
  "settings",
  "adminOverride",
];

// تحويل أي قيمة إلى Boolean مضبوط
const toBool = (v) =>
  v === true ||
  v === 1 ||
  v === "1" ||
  v === "true" ||
  v === "on" ||
  v === "yes";

// تطبيع كائن الصلاحيات من أي حقل كان (permissions | perms)
function normalizePerms(doc) {
  const src = (doc && (doc.permissions || doc.perms || doc)) || {};
  const out = {};
  for (const k of PERM_KEYS) out[k] = toBool(src[k] ?? false);
  return out;
}

// ========== قائمة الفنيين ==========
router.get("/", async (req, res) => {
  const techs = await User.find({ role: "technician" })
    .select("name username commissionPct permissions perms createdAt")
    .lean();

  const result = techs.map((t) => ({
    ...t,
    permissions: normalizePerms(t),
  }));
  res.json(result);
});

// ========== بروفايل الفني ==========
router.get("/:id/profile", async (req, res) => {
  const techId = req.params.id;
  const tech = await User.findById(techId)
    .select("name commissionPct permissions perms")
    .lean();
  if (!tech) return res.status(404).json({ message: "Technician not found" });

  const settings = await Settings.findOne().lean();
  const commissionPct =
    tech.commissionPct ?? settings?.defaultTechCommissionPct ?? 50;

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
});

// ========== إنشاء فني جديد (أدمن فقط) ==========
router.post("/", checkPermission("adminOverride"), async (req, res) => {
  const {
    name,
    username,
    password,
    commissionPct = 50,
    permissions,
  } = req.body || {};
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
    perms: normPerms, // نحفظ في الحقلين لتوافق الإصدارات
  });
  await u.save();
  res.json({ ok: true, id: u._id });
});

// ========== تحديث بيانات وصلاحيات الفني (أدمن فقط) ==========
router.put("/:id", checkPermission("adminOverride"), async (req, res) => {
  const { name, username, commissionPct, permissions, password } =
    req.body || {};
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ message: "Not found" });

  if (typeof name === "string") u.name = name;
  if (typeof username === "string") u.username = username;
  if (typeof commissionPct !== "undefined")
    u.commissionPct = Number(commissionPct);

  if (permissions && typeof permissions === "object") {
    // نقرأ الموجود (من أي حقل) ثم ندمج المدخلات بعد تطبيعها
    const current = normalizePerms(u);
    const incoming = normalizePerms(permissions);
    const merged = { ...current, ...incoming };

    u.permissions = merged;
    u.perms = merged; // كتابة في الحقلين
    u.markModified("permissions");
    u.markModified("perms");
  }

  if (password) {
    const salt = await bcrypt.genSalt(10);
    u.password = await bcrypt.hash(password, salt);
  }

  await u.save();
  res.json({ ok: true, permissions: normalizePerms(u) });
});

// ========== حذف فني ==========
router.delete("/:id", checkPermission("adminOverride"), async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
