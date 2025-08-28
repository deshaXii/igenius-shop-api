"use strict";
const { Schema, model } = require("mongoose");

const TxSchema = new Schema(
  {
    type: { type: String, enum: ["in", "out"], required: true },
    amount: { type: Number, required: true },
    description: { type: String, default: "" },
    date: { type: Date, default: Date.now },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

TxSchema.index({ date: 1 });
module.exports = model("Transaction", TxSchema);
