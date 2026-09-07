require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const TB_BASE_URL = process.env.TB_BASE_URL || 'https://thingsboard.cloud';
const TB_USERNAME = process.env.TB_USERNAME;
const TB_PASSWORD = process.env.TB_PASSWORD;

const BAY_CONFIG = [
  { id: 'BAY1', deviceId: process.env.BAY1_DEVICE_ID },
  { id: 'BAY2', deviceId: process.env.BAY2_DEVICE_ID },
  { id: 'BAY3', deviceId: process.env.BAY3_DEVICE_ID }
];

let cachedToken = null;
let tokenExpiresAt = 0;
let cachedData = null;
let lastFetchTime = 0;

// 1. Securely log into ThingsBoard Cloud
async function getThingsBoardToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;

  try {
    const res = await axios.post(`${TB_BASE_URL}/api/auth/login`, {
      username: TB_USERNAME,
      password: TB_PASSWORD
    });
    cachedToken = res.data.token;
    tokenExpiresAt = now + 7200 * 1000;
    return cachedToken;
  } catch (err) {
    console.error('[TB Auth Error]:', err.response ? err.response.data : err.message);
    throw new Error('Failed to authenticate with ThingsBoard');
  }
}

// Helper to extract values safely
function extractValue(timeseriesObj, key, defaultValue) {
  if (timeseriesObj && timeseriesObj[key] && timeseriesObj[key].length > 0) {
    const val = timeseriesObj[key][0].value;
    if (val === 'true') return true;
    if (val === 'false') return false;
    const num = Number(val);
    return isNaN(num) ? val : num;
  }
  return defaultValue;
}

// 2. Fetch live telemetry for a specific bay
async function fetchBayTelemetry(token, deviceId, defaultBayId) {
  if (!deviceId || deviceId.includes('replace_with')) {
    return {
      bayId: defaultBayId, status: 'FREE', voltage: 0, current: 0, power: 0,
      temperature: 0, predictArrivalProb: 0, predictDurationMin: 0, 
      throttleLevel: 100, loadDecision: 'STANDBY', overloadActive: false,
      initialSoc: 50, batteryCapacity: 5000, vehicleType: 1, Day: 0, Time: 0
    };
  }

  const keys = 'bayStatus,voltage,current,power,temperature,predictProbablity,predictDuration,throttleLevel,loadDecision,overloadActive,initialSoc,batteryCapacity,vehicleType,Day,Time';
  
  try {
    const url = `${TB_BASE_URL}/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${keys}`;
    const res = await axios.get(url, { headers: { 'X-Authorization': `Bearer ${token}` } });
    const data = res.data;
    
    let status = extractValue(data, 'bayStatus', 'FREE');
    let power = extractValue(data, 'power', 0);
    let current = extractValue(data, 'current', 0);

    // Enforce power and current to zero if bay is free or no vehicle allocation
    if (status === 'FREE' || power <= 0) {
      power = 0;
      current = 0;
    }

    return {
      bayId: defaultBayId,
      status: status,
      voltage: extractValue(data, 'voltage', 0),
      current: current,
      power: power,
      temperature: extractValue(data, 'temperature', 0),
      predictArrivalProb: extractValue(data, 'predictProbablity', 0),
      predictDurationMin: extractValue(data, 'predictDuration', 0),
      throttleLevel: extractValue(data, 'throttleLevel', 100),
      loadDecision: extractValue(data, 'loadDecision', 'ALLOW'),
      overloadActive: extractValue(data, 'overloadActive', false),
      initialSoc: extractValue(data, 'initialSoc', 50),
      batteryCapacity: extractValue(data, 'batteryCapacity', 5000),
      vehicleType: extractValue(data, 'vehicleType', 1),
      Day: extractValue(data, 'Day', 0),
      Time: extractValue(data, 'Time', 0)
    };
  } catch (err) {
    console.error(`[Fetch Error for ${defaultBayId}]:`, err.message);
    return { 
      bayId: defaultBayId, status: 'FREE', power: 0, current: 0, predictDurationMin: 0, 
      throttleLevel: 100, temperature: 0, initialSoc: 50, batteryCapacity: 5000, vehicleType: 1, Day: 0, Time: 0 
    };
  }
}

// 3. Serve aggregated live data to the frontend UI
app.get('/api/station-status', async (req, res) => {
  const now = Date.now();
  const cacheTtl = parseInt(process.env.CACHE_TTL_MS, 10) || 3000;

  if (cachedData && now - lastFetchTime < cacheTtl) {
    return res.json(cachedData);
  }

  try {
    const token = await getThingsBoardToken();
    const bayPromises = BAY_CONFIG.map(b => fetchBayTelemetry(token, b.deviceId, b.id));
    const bays = await Promise.all(bayPromises);

    // Explicitly subtract each bay consumption mathematically from 30000W total
    const maxStationCapacityW = 30000;
    let bay1Power = bays[0] ? bays[0].power : 0;
    let bay2Power = bays[1] ? bays[1].power : 0;
    let bay3Power = bays[2] ? bays[2].power : 0;

    const totalStationPower = bay1Power + bay2Power + bay3Power;
    const remainingPowerW = maxStationCapacityW - bay1Power - bay2Power - bay3Power;
    const activeBays = bays.filter(b => b.status === 'CHARGING').length;

    cachedData = {
      timestamp: new Date().toISOString(),
      station: {
        totalPowerW: totalStationPower,
        maxCapacityW: maxStationCapacityW,
        remainingPowerW: Math.max(0, remainingPowerW),
        utilizationPercent: Math.min(100, Math.round((totalStationPower / maxStationCapacityW) * 100)),
        activeBaysCount: activeBays,
        stationOverloaded: totalStationPower > maxStationCapacityW
      },
      bays
    };

    lastFetchTime = now;
    res.json(cachedData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync with hardware', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EV Project Ayush Server running at http://localhost:${PORT}`);
});