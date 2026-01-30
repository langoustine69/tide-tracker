import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const NOAA_API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const NOAA_STATIONS = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';

// Featured stations for the free endpoint
const FEATURED_STATIONS = [
  { id: '9414290', name: 'San Francisco, CA' },
  { id: '8518750', name: 'The Battery, NY' },
  { id: '8723214', name: 'Miami Beach, FL' },
  { id: '1612340', name: 'Honolulu, HI' },
  { id: '9410660', name: 'Los Angeles, CA' },
];

async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// Get today's date in YYYYMMDD format
function getDateStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Parse NOAA tide predictions
function parseTides(predictions: any[]) {
  return predictions.map((p: any) => ({
    time: p.t,
    height: parseFloat(p.v),
    type: p.type === 'H' ? 'high' : p.type === 'L' ? 'low' : 'reading',
  }));
}

// Parse NOAA wind data
function parseWind(data: any[]) {
  if (!data || data.length === 0) return null;
  const latest = data[data.length - 1];
  return {
    time: latest.t,
    speed: parseFloat(latest.s),
    direction: parseInt(latest.d),
    directionLabel: latest.dr,
    gust: parseFloat(latest.g),
  };
}

const agent = await createAgent({
  name: 'tide-tracker',
  version: '1.0.0',
  description: 'Real-time tide predictions, coastal conditions, and marine intelligence powered by NOAA data. Perfect for surfers, fishermen, boaters, and coastal enthusiasts.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === FREE: Overview of featured stations ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - current tide status for featured US coastal stations',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const featured = FEATURED_STATIONS[Math.floor(Math.random() * FEATURED_STATIONS.length)];
    const url = `${NOAA_API}?date=today&station=${featured.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`;
    
    const data = await fetchJSON(url);
    const tides = parseTides(data.predictions || []);
    
    return {
      output: {
        station: featured,
        tides,
        fetchedAt: new Date().toISOString(),
        dataSource: 'NOAA Tides & Currents (live)',
        availableStations: 3379,
        hint: 'Use paid endpoints for specific stations, forecasts, and full conditions',
      },
    };
  },
});

// === PAID $0.001: Today's tides for a specific station ===
addEntrypoint({
  key: 'tides',
  description: 'Get today\'s high/low tides for any NOAA station',
  input: z.object({
    stationId: z.string().describe('NOAA station ID (e.g., 9414290 for San Francisco)'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const url = `${NOAA_API}?date=today&station=${ctx.input.stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`;
    
    const data = await fetchJSON(url);
    if (data.error) {
      return { output: { error: data.error.message, stationId: ctx.input.stationId } };
    }
    
    const tides = parseTides(data.predictions || []);
    
    return {
      output: {
        stationId: ctx.input.stationId,
        date: new Date().toISOString().slice(0, 10),
        tides,
        units: 'feet (MLLW datum)',
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.002: Search stations by state ===
addEntrypoint({
  key: 'search',
  description: 'Search for tide stations by US state code',
  input: z.object({
    state: z.string().length(2).describe('US state code (e.g., CA, NY, FL, HI)'),
    limit: z.number().optional().default(20).describe('Max results to return'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const url = `${NOAA_STATIONS}/stations.json?type=tidepredictions`;
    const data = await fetchJSON(url);
    
    const stateUpper = ctx.input.state.toUpperCase();
    const stations = (data.stations || [])
      .filter((s: any) => s.state === stateUpper)
      .slice(0, ctx.input.limit)
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        state: s.state,
      }));
    
    return {
      output: {
        state: stateUpper,
        count: stations.length,
        stations,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.002: Multi-day forecast ===
addEntrypoint({
  key: 'forecast',
  description: 'Get tide predictions for multiple days ahead',
  input: z.object({
    stationId: z.string().describe('NOAA station ID'),
    days: z.number().min(1).max(7).optional().default(3).describe('Number of days (1-7)'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const beginDate = getDateStr(0);
    const endDate = getDateStr(ctx.input.days);
    
    const url = `${NOAA_API}?begin_date=${beginDate}&end_date=${endDate}&station=${ctx.input.stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`;
    
    const data = await fetchJSON(url);
    if (data.error) {
      return { output: { error: data.error.message, stationId: ctx.input.stationId } };
    }
    
    const tides = parseTides(data.predictions || []);
    
    // Group by date
    const byDate: Record<string, any[]> = {};
    for (const tide of tides) {
      const date = tide.time.split(' ')[0];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(tide);
    }
    
    return {
      output: {
        stationId: ctx.input.stationId,
        days: ctx.input.days,
        forecast: byDate,
        units: 'feet (MLLW datum)',
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.003: Current conditions (tides + wind) ===
addEntrypoint({
  key: 'conditions',
  description: 'Get full current conditions including tides and wind',
  input: z.object({
    stationId: z.string().describe('NOAA station ID'),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const [tidesData, windData, stationData] = await Promise.all([
      fetchJSON(`${NOAA_API}?date=today&station=${ctx.input.stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`),
      fetchJSON(`${NOAA_API}?date=today&station=${ctx.input.stationId}&product=wind&time_zone=lst_ldt&units=english&format=json`).catch(() => ({ data: [] })),
      fetchJSON(`${NOAA_STATIONS}/stations/${ctx.input.stationId}.json`).catch(() => ({ stations: [] })),
    ]);
    
    const station = stationData.stations?.[0] || {};
    const tides = tidesData.error ? [] : parseTides(tidesData.predictions || []);
    const wind = parseWind(windData.data);
    
    return {
      output: {
        station: {
          id: ctx.input.stationId,
          name: station.name || 'Unknown',
          lat: station.lat,
          lng: station.lng,
          state: station.state,
          timezone: station.timezone,
        },
        tides,
        wind,
        units: {
          tide: 'feet (MLLW datum)',
          wind: 'knots',
        },
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID $0.005: Comprehensive coastal report ===
addEntrypoint({
  key: 'report',
  description: 'Full coastal intelligence report with tides, forecast, nearby stations, and conditions',
  input: z.object({
    stationId: z.string().describe('NOAA station ID'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const beginDate = getDateStr(0);
    const endDate = getDateStr(5);
    
    const [todayTides, forecastTides, windData, stationData] = await Promise.all([
      fetchJSON(`${NOAA_API}?date=today&station=${ctx.input.stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`),
      fetchJSON(`${NOAA_API}?begin_date=${beginDate}&end_date=${endDate}&station=${ctx.input.stationId}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&interval=hilo`),
      fetchJSON(`${NOAA_API}?date=today&station=${ctx.input.stationId}&product=wind&time_zone=lst_ldt&units=english&format=json`).catch(() => ({ data: [] })),
      fetchJSON(`${NOAA_STATIONS}/stations/${ctx.input.stationId}.json`).catch(() => ({ stations: [] })),
    ]);
    
    const station = stationData.stations?.[0] || {};
    const todayParsed = todayTides.error ? [] : parseTides(todayTides.predictions || []);
    const forecastParsed = forecastTides.error ? [] : parseTides(forecastTides.predictions || []);
    const wind = parseWind(windData.data);
    
    // Find next high and low
    const now = new Date();
    const upcoming = todayParsed.filter((t) => new Date(t.time.replace(' ', 'T')) > now);
    
    // Forecast by date
    const byDate: Record<string, any[]> = {};
    for (const tide of forecastParsed) {
      const date = tide.time.split(' ')[0];
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(tide);
    }
    
    return {
      output: {
        station: {
          id: ctx.input.stationId,
          name: station.name || 'Unknown',
          lat: station.lat,
          lng: station.lng,
          state: station.state,
          timezone: station.timezone,
          tideType: station.tideType,
        },
        today: {
          tides: todayParsed,
          nextTide: upcoming[0] || null,
        },
        fiveDayForecast: byDate,
        currentWind: wind,
        summary: {
          highTidesPerDay: Math.round(todayParsed.filter((t) => t.type === 'high').length),
          lowTidesPerDay: Math.round(todayParsed.filter((t) => t.type === 'low').length),
          windConditions: wind ? (wind.speed > 15 ? 'windy' : wind.speed > 8 ? 'moderate' : 'calm') : 'unknown',
        },
        units: {
          tide: 'feet (MLLW datum)',
          wind: 'knots',
        },
        generatedAt: new Date().toISOString(),
        dataSource: 'NOAA Tides & Currents',
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🌊 Tide Tracker agent running on port ${port}`);

export default { port, fetch: app.fetch };
