// routes/autocomplete.js
const express = require('express');
const fetch = require('node-fetch'); // npm i node-fetch@2
const router = express.Router();

// GET /api/autocomplete?input=...&sessiontoken=optional
router.get('/', async (req, res) => {
  try {
    const { input, sessiontoken } = req.query;
    if (!input) return res.status(400).json({ status: 'INVALID_REQUEST', error: 'input required' });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ status: 'ERROR', error: 'missing_api_key' });
    }

    const params = new URLSearchParams({ input, key: apiKey });
    if (sessiontoken) params.set('sessiontoken', sessiontoken);

    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`;
    const r = await fetch(url);
    const txt = await r.text();

    let data; try { data = JSON.parse(txt); } catch { data = { parseError: true, txt }; }
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ status: 'ERROR', error: 'server_error' });
  }
});

// GET /api/autocomplete/details?place_id=...&sessiontoken=optional
router.get('/details', async (req, res) => {
  try {
    const { place_id, sessiontoken } = req.query;
    if (!place_id) return res.status(400).json({ status: 'INVALID_REQUEST', error: 'place_id required' });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ status: 'ERROR', error: 'missing_api_key' });
    }

    const params = new URLSearchParams({
      place_id,
      key: apiKey,
      fields: 'geometry,name,formatted_address,place_id',
    });
    if (sessiontoken) params.set('sessiontoken', sessiontoken);

    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
    const r = await fetch(url);
    const txt = await r.text();

    let data; try { data = JSON.parse(txt); } catch { data = { parseError: true, txt }; }
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ status: 'ERROR', error: 'server_error' });
  }
});

module.exports = router;