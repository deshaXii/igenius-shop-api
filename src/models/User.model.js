// src/models/User.model.js
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const PermissionsSchema = new mongoose.Schema(
  {
    addRepair: { type: Boolean, default: false },
    editRepair: { type: Boolean, default: false },
    deleteRepair: { type: Boolean, default: false },
    receiveDevice: { type: Boolean, default: false },
    accessAccounts: { type: Boolean, default: false },
    adminOverride: { type: Boolean, default: false },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, unique: true, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["admin", "technician"],
      default: "technician",
    },
    permissions: { type: PermissionsSchema, default: () => ({}) },
    // النسبة الخاصة بالفني (إن وُجدت) — تمثل نسبة الفني من ربح الصيانة (0-100)
    commissionPct: { type: Number, min: 0, max: 100, default: undefined },
  },
  { timestamps: true }
);

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
