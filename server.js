// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ---- Boot logs & global error handlers
console.log('[BOOT] Entered server.js in', __dirname);
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  process.exit(1);
});

// ---- Load service account safely
const saPath = path.join(__dirname, 'serviceAccountKey.json');
console.log('[BOOT] Using service account at:', saPath);

let serviceAccount;
try {
  serviceAccount = require(saPath);
} catch (e) {
  console.error('[ERROR] Missing or unreadable serviceAccountKey.json at:', saPath);
  console.error('        If you moved folders, copy the key file here.');
  process.exit(1);
}

// ---- Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('[BOOT] Firebase Admin initialized');
} catch (e) {
  console.error('[ERROR] Firebase Admin init failed:', e);
  process.exit(1);
}

const db = admin.firestore();

const app = express();
app.get('/health', (req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ---- Routes
app.get('/', (req, res) => {
  res.send('PlanIt backend is running!');
});

app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  });
});

app.get('/api/maptiler-key', (req, res) => {
  const key = process.env.MAPTILER_API_KEY;
  if (!key) return res.status(500).json({ error: 'MapTiler key missing' });
  res.status(200).json({ key });
});

app.get('/api/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  try {
    const snapshot = await db.collection('users').where('username', '==', String(username).toLowerCase()).get();
    res.status(200).json({ available: snapshot.empty });
  } catch (error) {
    console.error('[ERROR] /api/check-username', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Autocomplete route (make sure this file exists and exports an Express router)
try {
  const autocompleteRoute = require('./routes/autocomplete');
  app.use('/api/autocomplete', autocompleteRoute);
  console.log('[BOOT] Mounted /api/autocomplete');
} catch (e) {
  console.warn('[WARN] Could not mount /api/autocomplete:', e.message);
}

// --- Vercel compatibility ---
if (process.env.VERCEL) {
  module.exports = app; // Export for Vercel serverless handler
} else {
  // Local dev only
  app.listen(PORT, () => {
    console.log(`✅ PlanIt backend listening on http://localhost:${PORT}`);
  });
}