const { app } = require("../src/app");

// Vercel Serverless Function entrypoint.
// Express apps are compatible: (req, res) => void
module.exports = app;

