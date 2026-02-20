const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    /** Wallet address (unique, from thirdweb). */
    address: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    /** Email if user signed in with email or Google. */
    email: { type: String, default: null, trim: true, lowercase: true },
    /** Phone if user signed in with SMS. */
    phone: { type: String, default: null, trim: true },
    /** thirdweb in-app wallet user id. */
    thirdwebUserId: { type: String, default: null, trim: true },
    /** Public username chosen by the user during onboarding. */
    username: {
      type: String,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 20,
      match: /^[a-z0-9_]+$/,
    },
    /** Permanent DotPay identifier shown to merchants and peers. */
    dotpayId: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
    },
    /** Auth method: google | email | phone | wallet. */
    authMethod: {
      type: String,
      enum: ["google", "email", "phone", "wallet", null],
      default: null,
    },
    /** When the thirdweb user was created (in-app). */
    thirdwebCreatedAt: { type: Date, default: null },

    /**
     * Hashed 6-digit app PIN.
     * Format: scrypt$<salt_b64>$<hash_b64>
     */
    pinHash: { type: String, default: null, trim: true },
    pinUpdatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

// address index is created by unique: true above
userSchema.index({ email: 1 }, { sparse: true });
userSchema.index({ phone: 1 }, { sparse: true });
userSchema.index({ username: 1 }, { unique: true, sparse: true });
userSchema.index({ dotpayId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("User", userSchema);
