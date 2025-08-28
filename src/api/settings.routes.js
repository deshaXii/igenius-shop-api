// src/api/settings.routes.js
const express = require("express");
const router = express.Router();
const Settings = require("../models/Settings.model");
const User = require("../models/User.model");
const auth = require("../middleware/auth");
const checkPermission = require("../middleware/checkPermission");

router.use(auth);
router.use(checkPermission("accessAccounts")); // أو أن تجعلها admin-only حسب رغبتك

// Get settings
router.get("/", async (req, res) => {
  const s = await Settings.findOne().lean();
  res.json(s || { defaultTechCommissionPct: 50 });
});

// Update default commission pct
router.put("/", async (req, res) => {
  const pct = Number(req.body.defaultTechCommissionPct);
  if (isNaN(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ message: "Invalid percentage" });
  }
  let s = await Settings.findOne();
  if (!s) s = new Settings();
  s.defaultTechCommissionPct = pct;
  await s.save();
  res.json({ ok: true, settings: { defaultTechCommissionPct: pct } });
});

// Set per-technician override
router.put("/technicians/:id/commission", async (req, res) => {
  const pct = Number(req.body.commissionPct);
  if (isNaN(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ message: "Invalid percentage" });
  }
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: "Technician not found" });
  user.commissionPct = pct;
  await user.save();
  res.json({
    ok: true,
    user: { id: user._id, commissionPct: user.commissionPct },
  });
});

module.exports = router;
