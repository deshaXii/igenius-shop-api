// src/models/Settings.model.js
"use strict";

const mongoose = require("mongoose");

const SocialLinkSchema = new mongoose.Schema(
  {
    platform: { type: String, trim: true }, // Facebook / Instagram / TikTok / ...
    url: { type: String, trim: true },
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema(
  {
    // نسبة الفني الافتراضية (0-100)
    defaultTechCommissionPct: { type: Number, min: 0, max: 100, default: 50 },

    // أرقام تليفونات المحل (متعددة)
    phoneNumbers: { type: [String], default: [] },

    // روابط السوشيال
    socialLinks: { type: [SocialLinkSchema], default: [] },

    // إعدادات الإيصال الحراري
    receiptMessage: {
      type: String,
      default: "",
    }, // تُعرض تحت "يُرجى إحضار هذه الورقة عند الاستلام"

    receiptFontSizePt: { type: Number, min: 8, max: 24, default: 12 }, // بالحجم النقطي pt
    receiptPaperWidthMm: { type: Number, min: 40, max: 120, default: 80 }, // 58mm/80mm
    receiptMarginMm: { type: Number, min: 0, max: 20, default: 5 }, // هوامش من كل الجوانب بالملِّيمتر
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Settings || mongoose.model("Settings", SettingsSchema);
