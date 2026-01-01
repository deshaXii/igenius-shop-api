const mongoose = require("mongoose");

/* ===== Flow per department ===== */
const RepairFlowSchema = new mongoose.Schema(
  {
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      required: true,
      index: true,
    },
    // مهم: الفني هو User
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    status: {
      type: String,
      enum: ["waiting", "in_progress", "completed"],
      default: "waiting",
      index: true,
    },
    price: { type: Number, default: 0 }, // تسعير القسم على الصيانة
    notes: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: true, timestamps: true }
);

/* ===== Parts ===== */
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

/* ===== Public tracking ===== */
const PublicTrackingSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    token: { type: String, unique: true, sparse: true, index: true },
    showPrice: { type: Boolean, default: true },
    showEta: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastViewedAt: Date,
    views: { type: Number, default: 0 },
    expiresAt: Date,
    passcodeHash: String,
  },
  { _id: false }
);

/* ===== Embedded events for timeline (distinct from external Log model) ===== */
const RepairEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "create",
        "assign_department",
        "assign_technician",
        "flow_start",
        "flow_complete",
        "move_next",
        "status_change",
        "price_set",
      ],
      required: true,
    },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

/* ===== Repair ===== */
const RepairSchema = new mongoose.Schema(
  {
    repairId: { type: Number, unique: true, index: true },

    customerName: { type: String, required: true, trim: true },
    deviceType: { type: String, required: true, trim: true },
    issue: { type: String, trim: true },
    color: { type: String, trim: true },
    phone: { type: String, trim: true },

    price: { type: Number, default: 0 },
    finalPrice: { type: Number, default: 0 },

    technician: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    parts: { type: [PartSchema], default: [] },

    // القسم الحالي (ونبقي على department للتوافق)
    currentDepartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      index: true,
      default: null,
    },
    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      index: true,
      default: null,
    },

    // مسار الأقسام
    flows: { type: [RepairFlowSchema], default: [] },

    status: {
      type: String,
      enum: ["في الانتظار", "جاري العمل", "مكتمل", "تم التسليم", "مرفوض", "مرتجع"],
      default: "في الانتظار",
    },

    // Warranty
    hasWarranty: { type: Boolean, default: false },
    warrantyEnd: { type: Date, default: null },
    warrantyNotes: { type: String, trim: true, default: "" },

    customerFeedback: {
      rating: { type: Number, min: 1, max: 5 },
      note: { type: String, trim: true },
      createdAt: { type: Date },
    },

    // Updates for public tracking
    customerUpdates: {
      type: [
        {
          type: {
            type: String,
            enum: ["text", "image", "video", "audio"],
            required: true,
          },
          text: { type: String, default: "" },
          fileUrl: { type: String, default: "" },
          createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          createdAt: { type: Date, default: Date.now },
          isPublic: { type: Boolean, default: true },
        },
      ],
      default: [],
    },

    // أحداث داخلية للتايملاين (embed)
    events: { type: [RepairEventSchema], default: [] },

    notes: { type: String, trim: true },

    publicTracking: { type: PublicTrackingSchema, default: () => ({}) },

    // Times
    startTime: { type: Date },
    endTime: { type: Date },
    deliveryDate: { type: Date },
    eta: { type: Date },

    // Shop info
    shopName: { type: String, trim: true },
    shopPhone: { type: String, trim: true },
    shopWhatsapp: { type: String, trim: true },
    shopAddress: { type: String, trim: true },
    shopWorkingHours: { type: String, trim: true },

    returned: { type: Boolean, default: false },
    returnDate: { type: Date },

    rejectedDeviceLocation: {
      type: String,
      enum: ["بالمحل", "مع العميل", null],
      default: null,
    },

    notesPublic: { type: String },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { _id: true, timestamps: true }
);

// إضافة الحقول الجديدة
RepairSchema.add({
  currentDepartment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
    index: true,
    default: null,
  },
  department: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
    index: true,
    default: null,
  },
  flows: { type: [RepairFlowSchema], default: [] },
  logs: { type: [mongoose.Schema.Types.Mixed], default: [] },
});

/* ===== Virtuals / Indexes ===== */
RepairSchema.virtual("departmentPriceTotal").get(function () {
  return (this.flows || []).reduce((s, f) => s + (Number(f.price) || 0), 0);
});

RepairSchema.index({ currentDepartment: 1, updatedAt: -1 });
RepairSchema.index({ "flows.department": 1, "flows.status": 1 });
RepairSchema.index({ createdAt: 1 });
RepairSchema.index({ deliveryDate: 1 });
RepairSchema.index({ returnDate: 1 }); // ✅ مهم لعرض "مرتجع" في اليوم
RepairSchema.index({ "publicTracking.token": 1 }, { unique: true, sparse: true });

/* ===== Derive department from technician if missing ===== */
RepairSchema.pre("save", async function (next) {
  try {
    if (!this.department && this.technician) {
      const User = require("./User.model");
      const t = await User.findById(this.technician).select("department");
      if (t && t.department) {
        this.department = t.department;
        this.currentDepartment = t.department;
      }
    }
    next();
  } catch (e) {
    next(e);
  }
});

/* ===== One-off: drop legacy parts.id index if exists ===== */
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
        console.log("[repairs] Index drop check:", e.message);
      }
    };

    if (conn.readyState === 1) {
      doDrop();
    } else {
      conn.once("open", doDrop);
    }
  } catch (e) {
    console.log("[repairs] dropOldPartsIdIndexIfExists error:", e.message);
  }
}
dropOldPartsIdIndexIfExists();

module.exports = mongoose.models.Repair || mongoose.model("Repair", RepairSchema);
