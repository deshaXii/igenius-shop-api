// src/models/Repair.model.js
const mongoose = require("mongoose");

const PartSchema = new mongoose.Schema(
  {
    id: { type: Number },
    name: { type: String, required: true, trim: true },
    source: { type: String, trim: true },
    supplier: { type: String, trim: true },
    cost: { type: Number, default: 0 },
    purchaseDate: { type: Date, default: Date.now },
    qty: { type: Number, default: 1, min: 1 },
    paid: { type: Boolean, default: false },
    paidAt: { type: Date },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: true }
);

const PublicTrackingSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    token: { type: String, unique: true, sparse: true, index: true },
    showPrice: { type: Boolean, default: false },
    showEta: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastViewedAt: Date,
    views: { type: Number, default: 0 },
    expiresAt: Date,
    passcodeHash: String, // لو فعلت PIN مستقبلاً
  },
  { _id: false }
);

const RepairSchema = new mongoose.Schema(
  {
    repairId: { type: Number, unique: true, index: true },
    customerName: { type: String, required: true, trim: true },
    deviceType: { type: String, required: true, trim: true },
    issue: { type: String, trim: true },
    color: { type: String, trim: true },
    phone: { type: String, trim: true },
    price: { type: Number, default: 0 },
    technician: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    parts: { type: [PartSchema], default: [] },
    status: {
      type: String,
      enum: [
        "في الانتظار",
        "جاري العمل",
        "مكتمل",
        "تم التسليم",
        "مرفوض",
        "مرتجع",
      ],
      default: "في الانتظار",
    },

    logs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Log" }],
    notes: { type: String, trim: true },

    startTime: { type: Date },
    finalPrice: { type: Number },
    endTime: { type: Date },
    deliveryDate: { type: Date },

    returned: { type: Boolean, default: false },
    returnDate: { type: Date },

    rejectedDeviceLocation: {
      type: String,
      enum: ["بالمحل", "مع العميل", null],
      default: null,
    },

    publicTracking: { type: PublicTrackingSchema, default: () => ({}) },
    eta: { type: Date }, // موعد تسليم متوقع
    notesPublic: { type: String }, // ملاحظة قصيرة للعميل

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

RepairSchema.index({ createdAt: 1 });
RepairSchema.index({ deliveryDate: 1 });

RepairSchema.index(
  { "publicTracking.token": 1 },
  { unique: true, sparse: true }
);

async function dropOldPartsIdIndexIfExists() {
  try {
    const conn = mongoose.connection;
    if (!conn || typeof conn.collection !== "function") return;

    const doDrop = async () => {
      try {
        const coll = conn.collection("repairs");
        const idx = await coll.indexes();
        const target = idx.find(
          (i) => i.name === "parts.id_1" || (i.key && i.key["parts.id"] === 1)
        );
        if (target) {
          await coll.dropIndex(target.name);
          console.log("[repairs] Dropped legacy index:", target.name);
        }
      } catch (e) {
        // ما نوقفش السيرفر لو فشل — سجل فقط
        console.log("[repairs] Index drop check:", e.message);
      }
    };

    if (conn.readyState === 1) {
      // connected بالفعل
      doDrop();
    } else {
      conn.once("open", doDrop);
    }
  } catch (e) {
    console.log("[repairs] dropOldPartsIdIndexIfExists error:", e.message);
  }
}
dropOldPartsIdIndexIfExists();

module.exports =
  mongoose.models.Repair || mongoose.model("Repair", RepairSchema);
