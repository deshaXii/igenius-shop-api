// src/models/Settings.model.js
const mongoose = require("mongoose");

const SettingsSchema = new mongoose.Schema(
  {
    // نسبة الفني الافتراضية من ربح الصيانة (0-100). الباقي للمحل.
    defaultTechCommissionPct: { type: Number, min: 0, max: 100, default: 50 },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Settings || mongoose.model("Settings", SettingsSchema);
