// server.js
require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

console.log("[BOOT] Entered server.js in", __dirname);
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

// ---- Load service account (env for Vercel, file only for local dev)
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("[BOOT] Loaded service account from env");
  } else {
    const saPath = path.join(__dirname, "serviceAccountKey.json");
    serviceAccount = require(saPath);
    console.log("[BOOT] Loaded service account from file:", saPath);
  }
} catch (e) {
  console.warn(
    "[WARN] No Firebase service account available. Admin will not init.",
    e?.message || e
  );
}

// ---- Firebase Admin
try {
  if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("[BOOT] Firebase Admin initialized");
  } else if (!serviceAccount) {
    console.warn("[BOOT] Skipping Firebase Admin init (missing credentials).");
  }
} catch (e) {
  console.error("[ERROR] Firebase Admin init failed:", e);
  // don't exit on serverless
}

const db = admin.apps.length ? admin.firestore() : null;

const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 5000;

// ✅ increase body size limits for base64 images
app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true, limit: '6mb' }));

// ---- Routes
app.get('/', (req, res) => {
  res.send('PlanIt backend is running!');
});

app.get("/api/firebase-config", (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  });
});

app.get("/api/maptiler-key", (req, res) => {
  const key = process.env.MAPTILER_API_KEY;
  if (!key) return res.status(500).json({ error: "MapTiler key missing" });
  res.status(200).json({ key });
});

app.get("/api/check-username", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Username is required" });
  if (!db) return res.status(500).json({ error: "Firestore not initialized" });

  try {
    const snapshot = await db
      .collection("users")
      .where("username", "==", String(username).toLowerCase())
      .get();
    res.status(200).json({ available: snapshot.empty });
  } catch (error) {
    console.error("[ERROR] /api/check-username", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Autocomplete route
try {
  const autocompleteRoute = require("./routes/autocomplete");
  app.use("/api/autocomplete", autocompleteRoute);
  console.log("[BOOT] Mounted /api/autocomplete");
} catch (e) {
  console.warn("[WARN] Could not mount /api/autocomplete:", e.message);
}

try {
  const locationRoute = require("./routes/location");
  app.use("/api/location", locationRoute);
  console.log("[BOOT] Mounted /api/location");
} catch (e) {
  console.warn("[WARN] Could not mount /api/location:", e.message);
}

try {
  const tripRoute = require("./routes/trip");
  app.use("/api/trip", tripRoute);
  console.log("[BOOT] Mounted /api/trip");
} catch (e) {
  console.warn("[WARN] Could not mount /api/trip:", e.message);
}

// --- Vercel compatibility ---
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`✅ PlanIt backend listening on http://localhost:${PORT}`);
  });
}