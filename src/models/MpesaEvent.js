const mongoose = require("mongoose");

const mpesaEventSchema = new mongoose.Schema(
  {
    eventKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    transactionId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
      enum: ["webhook", "reconcile", "system"],
      default: "webhook",
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

mpesaEventSchema.index({ transactionId: 1, receivedAt: -1 });

module.exports = {
  MpesaEvent: mongoose.model("MpesaEvent", mpesaEventSchema),
};
