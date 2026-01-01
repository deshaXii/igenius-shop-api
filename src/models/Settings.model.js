// src/models/Settings.model.js
"use strict";

const mongoose = require("mongoose");

const SocialLinkSchema = new mongoose.Schema(
  {
    platform: { type: String, trim: true },
    url: { type: String, trim: true },
  },
  { _id: false }
);

const SubscriptionSchema = new mongoose.Schema(
  {
    planName: { type: String, trim: true, default: "Yearly" },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    cycle: { type: String, enum: ["yearly"], default: "yearly" },
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema(
  {
    defaultTechCommissionPct: { type: Number, min: 0, max: 100, default: 50 },

    phoneNumbers: { type: [String], default: [] },
    socialLinks: { type: [SocialLinkSchema], default: [] },

    receiptMessage: { type: String, default: "" },
    receiptFontSizePt: { type: Number, min: 8, max: 24, default: 12 },
    receiptPaperWidthMm: { type: Number, min: 40, max: 120, default: 80 },
    receiptMarginMm: { type: Number, min: 0, max: 20, default: 5 },

    // ✅ Subscription
    subscription: { type: SubscriptionSchema, default: () => ({}) },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Settings || mongoose.model("Settings", SettingsSchema);
