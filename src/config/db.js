const mongoose = require("mongoose");

// Reuse the same connection across serverless invocations.
// Vercel keeps the Node.js process warm between requests sometimes, so caching avoids
// creating a new connection every time.
let cached = global.__dotpay_mongoose;
if (!cached) {
  cached = global.__dotpay_mongoose = { conn: null, promise: null };
}

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set in environment variables.");
  }

  if (cached.conn) return cached.conn;

  // 1 = connected, 2 = connecting
  if (mongoose.connection.readyState === 1) {
    cached.conn = mongoose.connection;
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(uri)
      .then(() => mongoose.connection)
      .catch((err) => {
        cached.promise = null;
        throw err;
      });
  }

  cached.conn = await cached.promise;
  console.log("MongoDB connected");
  return cached.conn;
}

module.exports = { connectDB };
