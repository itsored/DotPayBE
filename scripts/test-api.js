/**
 * Test the DotPay backend API and MongoDB.
 * Prerequisite: Backend running (npm run dev in backend/).
 *
 * Run: node scripts/test-api.js
 * Or:  npm run test:api
 */

const BASE = process.env.API_BASE || "http://localhost:4000";
const TEST_ADDRESS = "0x" + "a".repeat(40);

async function test() {
  console.log("Testing DotPay API at", BASE, "\n");

  // 1. Health
  console.log("1. GET /health (or /api/health on serverless)");
  let healthRes = await fetch(`${BASE}/health`);
  if (!healthRes.ok) {
    healthRes = await fetch(`${BASE}/api/health`);
  }
  const health = await healthRes.json();
  if (!health.ok) {
    throw new Error("Health check failed: " + JSON.stringify(health));
  }
  console.log("   OK:", health, "\n");

  // 2. Create/update user (POST)
  console.log("2. POST /api/users (create/update user)");
  const postRes = await fetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: TEST_ADDRESS,
      email: "test@dotpay.xyz",
      phone: "+254700000000",
      userId: "thirdweb-test-id",
      authMethod: "email",
      createdAt: new Date().toISOString(),
    }),
  });
  const postData = await postRes.json();
  if (!postData.success) {
    throw new Error("POST /api/users failed: " + JSON.stringify(postData));
  }
  console.log("   OK:", postData.data);
  console.log("");

  // 3. Get user by address (GET)
  console.log("3. GET /api/users/:address");
  const getRes = await fetch(`${BASE}/api/users/${encodeURIComponent(TEST_ADDRESS)}`);
  const getData = await getRes.json();
  if (!getData.success) {
    throw new Error("GET /api/users/:address failed: " + JSON.stringify(getData));
  }
  console.log("   OK:", getData.data);
  console.log("");

  console.log("All API tests passed. Database is working as desired.");
}

test().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
