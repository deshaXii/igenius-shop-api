const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["داخل", "خارج"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    note: {
      type: String,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Account", accountSchema);
