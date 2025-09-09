// models/InventoryItem.model.js
const mongoose = require("mongoose");

const InventoryItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // وحّدنا القيم: part | accessory
    category: { type: String, enum: ["part", "accessory"], default: "part" },
    sku: { type: String, default: "" },

    unitCost: { type: Number, default: 0 },
    sellPrice: { type: Number, default: 0 },

    // الحقل الموحّد الجديد
    stock: { type: Number, default: 0 },
    // توافق مع القديم لو كان عندك qty
    qty: { type: Number, default: 0 },

    minStock: { type: Number },

    // ملاحظات (نوحّد notes/note)
    notes: { type: String, default: "" },
    note: { type: String, default: "" }, // توافق قديم

    // 🔴 ده اللي كان ناقص:
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier" },
  },
  { timestamps: true }
);

// توحيد تلقائي قبل الحفظ (stock/qty + notes/note)
InventoryItemSchema.pre("save", function (next) {
  if (this.stock == null) this.stock = this.qty || 0;
  if (this.qty == null) this.qty = this.stock || 0;

  if (!this.notes && this.note) this.notes = this.note;
  if (!this.note && this.notes) this.note = this.notes;

  next();
});

module.exports = mongoose.model("InventoryItem", InventoryItemSchema);
