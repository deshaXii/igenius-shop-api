// models/Supplier.model.js
const mongoose = require("mongoose");

function normalizeName(s = "") {
  return String(s)
    .normalize("NFKC") // توحيد أشكال الحروف
    .replace(/\s+/g, " ") // مسافة واحدة
    .trim()
    .toLowerCase(); // عدم حساسية لحالة الحروف (مهم للإنجليزي)
}

const SupplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameNormalized: { type: String, required: true, unique: true },
    phone: { type: String, default: "" },
    isShop: { type: Boolean, default: false }, // المورّد الثابت "المحل"
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

SupplierSchema.pre("validate", function (next) {
  if (this.name) this.nameNormalized = normalizeName(this.name);
  next();
});

SupplierSchema.statics.normalizeName = normalizeName;

SupplierSchema.index({ nameNormalized: 1 }, { unique: true });

module.exports = mongoose.model("Supplier", SupplierSchema);
