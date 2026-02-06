const { app } = require("../src/app");
const { connectDB } = require("../src/config/db");

module.exports = async (req, res) => {
  try {
    const url = req.url || "";
    const isHealth = url === "/api/health" || url.startsWith("/api/health?");

    if (!isHealth) {
      await connectDB();
    }

    return app(req, res);
  } catch (err) {
    console.error("Vercel function error:", err);
    return res.status(500).json({
      success: false,
      message: err?.message || "Internal Server Error",
    });
  }
};

