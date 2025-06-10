const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { parseStringPromise } = require('xml2js');
const Bottleneck = require('bottleneck');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const PORT = 3000;

app.use(cors());


// limitations
const MAX_TRANSER_WAIT_MINS = 60;
const MAX_LOOKAHEAD_HRS = 3; // mostly there are no 2 consecutive stations > 2h distance

const limiter = new Bottleneck({ minTime: 20 }); // DB API allows 60 requests per sec
const limitedFetch = limiter.wrap(fetch);

const cacheEva = new Map();
const cacheTimetable = new Map();

const staticEvas = new Map();

const EVA_MAP = {
  hamburg: '8002549',
  amsterdam: '8400058',
};

// to filter journeys based on their direction (like ignoring trains going to berlin)
const possibleTransferStations = [
  'Duisburg Hbf', 'Münster(Westf)Hbf', 'Osnabrück Hbf', // 'Köln Hbf', 'Bremen Hbf', 
  'Utrecht Centraal', // 'Düsseldorf Hbf', 'Essen Hbf', 
];

function getMinutesDifference(start, end) {
  let diff = (end - start) / (1000 * 60);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

const formatDateForDB = (date) => {
  // date: Date objesi
  const year = date.getFullYear().toString().slice(2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return year + month + day;
};

// only used with data coming from db api, so has berlin -> utc time conversion.
function parseDateTimeFromDB(pt) {
  if (!pt || pt.length !== 10) return null;

  const year = 2000 + parseInt(pt.slice(0, 2), 10);
  const month = parseInt(pt.slice(2, 4), 10);
  const day = parseInt(pt.slice(4, 6), 10);
  const hour = parseInt(pt.slice(6, 8), 10);
  const minute = parseInt(pt.slice(8, 10), 10);

  const berlinTimeStr = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}:00`;

  const berlinOffsetMinutes = new Date(berlinTimeStr + 'Z').getTimezoneOffset() - new Date(berlinTimeStr).getTimezoneOffset();
  const utcTimestamp = Date.parse(berlinTimeStr) - berlinOffsetMinutes * 60 * 1000;

  return new Date(utcTimestamp);
}

// db api wworks with germany time (obv)
function utcDateToBerlinHour(date) {
  const options = { hour: '2-digit', timeZone: 'Europe/Berlin', hour12: false };
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function berlinDateTimeToTimestamp(year, month, day, hour) {
  const berlinTimeStr = `${year}-${(month + 1).toString().padStart(2,'0')}-${day.toString().padStart(2,'0')}T${hour.toString().padStart(2,'0')}:00:00`;
  const utcDateStr = new Date(berlinTimeStr + 'Z').toLocaleString('en-US', { timeZone: 'Europe/Berlin' });
  const berlinDate = new Date(utcDateStr);
  return berlinDate.getTime();
}


function timetableContainsTrainId(timetableData, trainId) {
  if (!timetableData || !timetableData.timetable) return false;

  let entriesRaw = timetableData.timetable.s || [];
  if (!Array.isArray(entriesRaw)) entriesRaw = [entriesRaw];

  return entriesRaw.some(entry => {
    const trainIdRaw = entry.$?.id || entry.id || '';
    const trainIdMatch = trainIdRaw.match(/-?(\d+)-/);
    const id = trainIdMatch ? trainIdMatch[1] : trainIdRaw;
    return id === trainId;
  });
}


async function fetchTimetableRaw(eva, dateObj, hour) {
  const dateStr = dateObj.toISOString().slice(0, 10);
  const key = `${eva}_${dateStr}_${hour}`;
  if (cacheTimetable.has(key)) return cacheTimetable.get(key);

  const promise = (async () => {
    const url = `https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1/plan/${eva}/${formatDateForDB(dateObj)}/${hour}`;
    const res = await limitedFetch(url, {
      headers: {
        'DB-Client-Id': process.env.DB_CLIENT_ID,
        'DB-Api-Key': process.env.DB_API_KEY,
        accept: 'application/xml',
      },
    });

    if (!res.ok) {     
      cacheTimetable.delete(key);
      return null;
    }

    const xml = await res.text();
    const data = await parseStringPromise(xml, { explicitArray: false });

    cacheTimetable.set(key, data);

    return data;
  })();

  cacheTimetable.set(key, promise);
  return promise;
}

async function fetchTimetableWithFallback(eva, dateObj, startHour, minDepartureTime, trainId) {
  let hourToCheck = startHour;

  if (minDepartureTime instanceof Date) {
    const candidateHour = minDepartureTime.getUTCHours();
    if (candidateHour > startHour) {
      hourToCheck = candidateHour;
    }
  }

  hourToCheck = hourToCheck.toString().padStart(2, '0');

  let data = null;
  let currentDate = new Date(dateObj);
  let startDateTime = new Date(dateObj);

  if (!minDepartureTime) { // first station
    data = await fetchTimetableRaw(eva, currentDate, hourToCheck);
  } else {
    data = await fetchTimetableRaw(eva, currentDate, hourToCheck);
    while (!data || !timetableContainsTrainId(data, trainId)) {
      let nextHour = (parseInt(hourToCheck, 10) + 1);

      if (nextHour > 23) { // next day
        nextHour = 0;
        currentDate.setDate(currentDate.getDate() + 1);
      }

      hourToCheck = nextHour.toString().padStart(2, '0');
      data = await fetchTimetableRaw(eva, currentDate, hourToCheck);
      
      const dayDiff = (new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()) - new Date(startDateTime.getFullYear(), startDateTime.getMonth(), startDateTime.getDate())) / (1000 * 60 * 60 * 24);  // Gün farkı
      const hoursPassed = dayDiff * 24 + (parseInt(hourToCheck, 10) - startHour);

      if (!timetableContainsTrainId(data, trainId) && hoursPassed > MAX_LOOKAHEAD_HRS) {
        return null;
      }
    }
  }

  return data;
}

async function getEvaNo(stationName) {
  if (!stationName) return null;
  const key = stationName.toLowerCase();
  if (cacheEva.has(key)) return cacheEva.get(key);

  const promise = (async () => {
    const url = `https://apis.deutschebahn.com/db-api-marketplace/apis/timetables/v1/station/${encodeURIComponent(stationName)}`;
    const res = await limitedFetch(url, {
      headers: {
        'DB-Client-Id': process.env.DB_CLIENT_ID,
        'DB-Api-Key': process.env.DB_API_KEY,
        accept: 'application/xml',
      },
    });

    if (!res.ok) {
      cacheEva.set(key, null);
      return null;
    }

    const xml = await res.text();
    const data = await parseStringPromise(xml, { explicitArray: false });

    let stationEntry = null;
    if (data.stations && data.stations.station) {
      if (Array.isArray(data.stations.station)) {
        stationEntry = data.stations.station.find(s => s.$.name.toLowerCase() === key) || data.stations.station[0];
      } else {
        stationEntry = data.stations.station;
      }
      if (stationEntry && stationEntry.$ && stationEntry.$.eva) {
        return stationEntry.$.eva;
      }
    }
    return null;
  })();

  cacheEva.set(key, promise);

  return promise;
}

// used for pre-fetching data and filling cache. is this a hack?
async function initializeCache() {
  console.time("caching");
  const date = new Date();

  const initialSearchDateTime = new Date(date.getTime() - 10 * 60 * 60 * 1000);
  const finalSearchDateTime = new Date(date.getTime() + 18 * 60 * 60 * 1000);

  const promises = [];

  let current = new Date(initialSearchDateTime);
  current.setUTCMinutes(0, 0, 0);

  while (current <= finalSearchDateTime) {
    const calldateTime = new Date(current);
    current.setUTCHours(current.getUTCHours() + 1);

    const p = limiter.schedule({ priority: 0 }, () =>
      findJourneys(EVA_MAP['hamburg'], EVA_MAP['amsterdam'], calldateTime, 3)
    );
    promises.push(p);
  }

  await Promise.all(promises);
  console.timeEnd("caching");
}


async function reviseCache() {
  console.log("revising");
  const now = Date.now();
  const threshold = now - 13 * 60 * 60 * 1000;

  // DB API says planned entries never cange, so removing only oldest hour slot should be ok for reliable data.
  for (const [key, value] of cacheTimetable.entries()) {
    const parts = key.split('_');
    if (parts.length < 3) continue;

    const dateStr = parts[1];
    const hourStr = parts[2];

    const year = 2000 + parseInt(dateStr.slice(0, 2), 10);
    const month = parseInt(dateStr.slice(2, 4), 10) - 1; // 0 tabanlı ay
    const day = parseInt(dateStr.slice(4, 6), 10);
    const hour = parseInt(hourStr, 10);

    const cacheTime = berlinDateTimeToTimestamp(year, month, day, hour);
    console.log("revise cache berlin time: ", cacheTime);

    if (cacheTime < threshold) {
      cacheTimetable.delete(key);
    }
  }

  const newSearchDateTime = new Date(now + 18 * 60 * 60 * 1000);
  newSearchDateTime.setUTCMinutes(0, 0, 0);
  await findJourneys(EVA_MAP['hamburg'], EVA_MAP['amsterdam'], newSearchDateTime, 3)

}


function scheduleReviseCacheHourly() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  //nextHour.setHours(nextHour.getHours() + 1);

  const msUntilNextHour = nextHour - now;

  setTimeout(() => {
    limiter.schedule({ priority: 0 }, () => reviseCache());

    setInterval(() => {
      limiter.schedule({ priority: 0 }, () => reviseCache());
    }, 60 * 60 * 1000);
  }, msUntilNextHour);
}


async function findJourneys(startEva, targetEva, startDateTime, maxTransfers = 1, maxStops = 20, maxDurationMinutes = 960) {
  const berlinHour = parseInt(utcDateToBerlinHour(startDateTime), 10);

  //console.log(`Starting journey search from ${startEva} to ${targetEva} on ${dateStr} starting at Berlin hour ${berlinHour}`);
  const startStationName = startEva === EVA_MAP['hamburg'] ? 'Hamburg Hbf' : 'Amsterdam Centraal';

  const queue = [{
    stationId: startEva,
    stationName: startStationName,
    arrivalTime: null,
    path: [],
    currentTrainId: null,
    transfers: 0,
    startTime: null,
  }];

  const results = [];
  const visited = new Set();

  const journeyCountMap = new Map();

  while (queue.length > 0) {
    if (results.length >= 60) {
      //console.log('Maximum 10 journeys found, stopping search.');
      return results;
    }
    const node = queue.shift();

    if (node.path.length > maxStops) continue; // limit

    if (node.startTime && node.arrivalTime) {
      const journeyDuration = getMinutesDifference(node.startTime, node.arrivalTime);
      if (journeyDuration > maxDurationMinutes) continue; // limit
    }

    const visitedKey = `${node.stationId}_${node.trainId || ''}_${node.arrivalTime}`;
    if (visited.has(visitedKey)) continue; // limit
    visited.add(visitedKey);

    if (node.stationId === targetEva) { // reached target, fetch data one last time to get arrival time
      const dateWithHour = new Date(startDateTime);
      dateWithHour.setUTCHours(berlinHour, 0, 0, 0);
      const targetTimetable = await fetchTimetableWithFallback(targetEva, dateWithHour, (node.arrivalTime ? node.arrivalTime.getUTCHours() : berlinHour).toString().padStart(2, '0'), node.arrivalTime, node.currentTrainId);
      if (targetTimetable) {
        let arrivals = targetTimetable?.timetable?.s || [];
        if (!Array.isArray(arrivals)) arrivals = [arrivals];
        let targetArrivalTime = null;

        for (const trainEntry of arrivals) {
          const trainIdRaw = trainEntry.$?.id || trainEntry.id || '';
          const trainIdMatch = trainIdRaw.match(/-?(\d+)-/);
          const trainId = trainIdMatch ? trainIdMatch[1] : trainIdRaw;
          if (trainId === node.currentTrainId) {
            const arrivalPt = trainEntry.ar?.$?.pt;
            if (arrivalPt) {
              targetArrivalTime = parseDateTimeFromDB(arrivalPt);
              break;
            }
          }
        }

        if (targetArrivalTime && node.path.length > 0) {
          node.path[node.path.length - 1].arrival = targetArrivalTime;
        }
      }

      /*console.log(`Reached target ${targetEva} with path length ${node.path.length} and transfers ${node.transfers}`);
      node.path.forEach((leg, i) => {
        console.log(`  Leg ${i + 1}: Train ${leg.trainId}, from ${leg.from.name || leg.from.eva} departs ${leg.departure.toISOString()}, to ${leg.to.name || leg.to.eva} arrives ${leg.arrival ? leg.arrival.toISOString() : 'N/A'}`);
      });*/

      results.push({
        path: node.path,
        changes: node.transfers,
        startTime: node.startTime || (node.path.length > 0 ? node.path[0].departure : null),
        arrivalTime: (node.path.length > 0 ? node.path[node.path.length - 1].arrival : null),
      });

      continue;
    }

    if (node.transfers > maxTransfers) continue; // limit

    const queryHour = node.arrivalTime // hour slot to make the next query
      ? node.arrivalTime.getUTCHours().toString().padStart(2, '0')
      : berlinHour.toString().padStart(2, '0'); // ??

    const dateWithHour = new Date(startDateTime);
    dateWithHour.setUTCHours(parseInt(queryHour, 10), 0, 0, 0);

    const timetableData = await fetchTimetableWithFallback(node.stationId, dateWithHour, queryHour, node.arrivalTime, node.currentTrainId);
    if (!timetableData) continue;

    let entriesRaw = timetableData?.timetable?.s || [];
    if (!Array.isArray(entriesRaw)) entriesRaw = [entriesRaw];

    const visitedStationNames = [ // to prevent cycles
      ...node.path.flatMap(leg => [leg.from.name, leg.to.name].filter(Boolean))
    ];
    if (node.stationName && !visitedStationNames.includes(node.stationName)) {
      visitedStationNames.push(node.stationName);
    }

    const currentTrainEntry = entriesRaw.find(entry => {
      const trainIdRaw = entry.$?.id || entry.id || '';
      const trainIdMatch = trainIdRaw.match(/-?(\d+)-/);
      const id = trainIdMatch ? trainIdMatch[1] : trainIdRaw;
      return id === node.currentTrainId;
    });

    let currentTrainArrivalTime = null;
    if (currentTrainEntry) {
      const arrivalPt = currentTrainEntry.ar?.$?.pt;
      if (arrivalPt) {
        currentTrainArrivalTime = parseDateTimeFromDB(arrivalPt);
      }
    }

    for (const entry of entriesRaw) {
      const trainIdRaw = entry.$?.id || entry.id || '';
      const trainIdMatch = trainIdRaw.match(/-?(\d+)-/);
      const trainId = trainIdMatch ? trainIdMatch[1] : trainIdRaw;
      const trainType = entry?.tl?.$?.c || null;

      const dep = entry.dp?.$ || {};
      if (!dep.pt) continue;
      const departureDateTime = parseDateTimeFromDB(dep.pt);

      const arrivalDateTime = null;

      const ppthRaw = dep.ppth || '';
      const ppthStations = ppthRaw.split('|').filter(Boolean);

      if (ppthStations.some(stn => visitedStationNames.includes(stn))) continue;

      // const evaNos = await Promise.all(ppthStations.map(station => getEvaNo(station))); // precache in parallel so maybe becomes faster?? (slowed down lol)

      const possiblePathStations = startEva === EVA_MAP['hamburg']
        ? [...possibleTransferStations, 'Amsterdam Centraal']
        : [...possibleTransferStations, 'Hamburg Hbf'];
      
      if (ppthStations.every(stn => !possiblePathStations.includes(stn))) continue;

      let newTransfers = node.transfers;
      if (node.currentTrainId && node.currentTrainId !== trainId) { // possible change
        //console.log("id: ", node.currentTrainId, " arrtime: ", node.arrivalTime, "deptime", departureDateTime, "curr train arr time: ", currentTrainArrivalTime )
        if (currentTrainArrivalTime && departureDateTime <= currentTrainArrivalTime) continue; // times dont match
        const waitMinutes = (departureDateTime - currentTrainArrivalTime) / (1000 * 60);
        if (waitMinutes > MAX_TRANSER_WAIT_MINS) continue; // limit
        newTransfers = node.transfers + 1; // changed train
        if (newTransfers > maxTransfers) continue; // limit
      } else if (node.currentTrainId === trainId) {
        if (currentTrainArrivalTime && departureDateTime < currentTrainArrivalTime) continue; // this can't happen but just in case
      }

      for (const nextStationName of ppthStations) {
        const nextEva = await getEvaNo(nextStationName);
        if (!nextEva) continue;

        const newPath = node.path.slice();
        newPath.push({
          trainId,
          trainType,
          from: { eva: node.stationId, name: node.stationName },
          to: { eva: nextEva, name: nextStationName },
          departure: departureDateTime,
          arrival: null,
        });

        queue.push({
          stationId: nextEva,
          stationName: nextStationName,
          arrivalTime: departureDateTime,
          path: newPath,
          currentTrainId: trainId,
          transfers: newTransfers,
          startTime: node.startTime || departureDateTime,
        });
      }
    }
  }

  if (results.length === 0) {
    console.log(`No journey found from ${startEva} to ${targetEva}`);
    return null;
  }

  console.log(`Journeys found: ${results.length}`);
  return results;
}


app.get('/api/trips', async (req, res) => {
  console.time('requestDuration');

  const { is_departure = "true", date, hour = '00' } = req.query;
  if (!date) return res.status(400).json({ error: "Missing 'date'" });

  //console.log(`API called with date: ${date}, hour: ${hour}`);

  const from = is_departure === 'true' ? 'hamburg' : 'amsterdam';
  const evaNo = EVA_MAP[from.toLowerCase()];
  const targetEvaNo = is_departure === 'true' ? EVA_MAP['amsterdam'] : EVA_MAP['hamburg'];
  if (!evaNo) return res.status(400).json({ error: `Unknown from: ${from}` });

  try {
    const startDateTime = new Date(`${date}T${hour.padStart(2,'0')}:00:00Z`);

    const journeys = await limiter.schedule({ priority: 10 }, () => findJourneys(evaNo, targetEvaNo, startDateTime, 4, 12, 960));
    if (!journeys) return res.json({ journeys: [] });

    const response = journeys.map(journey => ({
      departure_date_time: journey.startTime ? journey.startTime.toISOString() : null,
      arrival_date_time: journey.arrivalTime ? journey.arrivalTime.toISOString() : null,
      changes: journey.changes,
      train: [...new Set(journey.path.map(leg => leg.trainType).filter(Boolean))].join('+'),
      sections: journey.path,
    }));

    console.timeEnd('requestDuration');

    res.json({ journeys: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);

  limiter.schedule({ priority: 0 }, () => initializeCache());
  scheduleReviseCacheHourly();
  setInterval(() => {
    cacheEva.clear();
  }, 24 * 60 * 60 * 1000); // 1 day
});
