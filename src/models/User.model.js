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
    // دعمًا لما تتوقعه الواجهة
    settings: { type: Boolean, default: false },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, unique: true, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    email: { type: String, required: false },
    role: {
      type: String,
      enum: ["admin", "technician"],
      default: "technician",
    },

    // صلاحيات مضبوطة على الـSchema
    permissions: { type: PermissionsSchema, default: () => ({}) },

    // للتوافق مع إصدارات قديمة كانت تستخدم perms حر
    perms: { type: mongoose.Schema.Types.Mixed, default: undefined },

    // فلاغ يوسّم الأدمن الأساسي القادم من seed
    isSeedAdmin: { type: Boolean, default: false, index: true },

    // نسبة الفني
    commissionPct: { type: Number, min: 0, max: 100, default: undefined },

    department: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
    },
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
