# DotPay Backend

Express.js backend for DotPay. Starting point for user storage and APIs.

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Environment**

   Copy `.env.example` to `.env` and set your MongoDB password:

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and replace `<db_password>` in `MONGODB_URI` with your Atlas user password.

   Optional:

   - `PORT` – server port (default `4000`)
   - `CLIENT_ORIGIN` – allowed CORS origin (default `http://localhost:3000`)

3. **Run**

   ```bash
   npm run dev   # development (with --watch)
   npm start    # production
   ```

   Server runs at `http://localhost:4000` (or your `PORT`).

## API

### Health

- **GET** `/health` – `{ ok: true, service: "dotpay-backend" }`
- **GET** `/api/health` – same response (useful for serverless deployments)

### Users

- **POST** `/api/users` – create or update user (from DotPay sign-in/sign-up).

  Body (matches frontend `SessionUser`):

  ```json
  {
    "address": "0x...",
    "email": "user@example.com",
    "phone": null,
    "userId": "thirdweb-user-id",
    "authMethod": "google",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "username": "your_name"
  }
  ```

  Response includes `username` and generated `dotpayId`:
  `{ success: true, data: { id, address, username, dotpayId, email, phone, ... } }`

- **PATCH** `/api/users/:address/identity` – set username and provision DotPay ID.

  Body:

  ```json
  {
    "username": "your_name"
  }
  ```

- **GET** `/api/users/:address` – get user by wallet address.

  Response: `{ success: true, data: { id, address, username, dotpayId, email, phone, ... } }`

## Frontend integration

1. **Backend must be running** (e.g. `npm run dev`).
2. In the **Next.js app** `.env`, set:
   ```bash
   NEXT_PUBLIC_DOTPAY_API_URL=http://localhost:4000
   ```
   (Use your backend URL in production.)
3. Users are synced automatically:
   - **On login/signup**: The app sends the wallet address to `POST /api/users` right after thirdweb auth, then sends full profile (email, phone, etc.) when the session user is loaded.

From the DotPay app, after sign-in/sign-up, the session user is sent to the backend automatically. To call manually:

```ts
// Example: call from AuthSessionContext or after redirect to /home
const sessionUser = useAuthSession().sessionUser;
if (sessionUser) {
  await fetch("http://localhost:4000/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: sessionUser.address,
      email: sessionUser.email,
      phone: sessionUser.phone,
      userId: sessionUser.userId,
      authMethod: sessionUser.authMethod,
      createdAt: sessionUser.createdAt,
    }),
  });
}
```

Use an env var (e.g. `NEXT_PUBLIC_DOTPAY_API_URL`) for the backend URL in production.

## MongoDB

Uses MongoDB Atlas. The `User` model is stored in the default database; you can add a database name to the URI if needed:

```
mongodb+srv://...@cluster0.v4yk9ay.mongodb.net/dotpay?appName=Cluster0
```

## Next steps

- Add authentication (e.g. verify thirdweb JWT or API key) before accepting `POST /api/users`.
- Add more collections and routes (wallets, transactions, etc.).

## Deploy to Vercel

This repo is set up to deploy on Vercel as serverless functions.

1. Push this repo to GitHub.
2. In Vercel: **Add New Project** -> import the GitHub repo.
3. Add these **Environment Variables** in Vercel (Production + Preview if you use preview deployments):
   - `MONGODB_URI` (required)
   - `CLIENT_ORIGIN` (recommended, used for CORS in production)
   - `DOTPAY_INTERNAL_API_KEY` (required for `/api/notifications/*`)
4. Deploy.

Notes:
- API endpoints remain at `/api/*` (e.g. `/api/users`).
- `/health` is rewritten to `/api/health` via `vercel.json`.
