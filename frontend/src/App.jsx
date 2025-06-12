import { useState, useEffect } from 'react';
import './App.css';

export default function App() {
  const [tripType, setTripType] = useState("one-way");
  const [departureDate, setDepartureDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [departureHour, setDepartureHour] = useState("08");
  const [returnHour, setReturnHour] = useState("08");
  const [sort, setSort] = useState("fastest");
  const [rawResults, setRawResults] = useState({ outbound: [], return: [] });
  const [results, setResults] = useState({ outbound: [], return: [] });
  const [loading, setLoading] = useState(false);

  const hours = Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0'));

  const BASE_URL = "https://smart-train-finder-c27y.onrender.com";

const formatTime = (isoString) => {
  if (!isoString) return 'N/A';
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
};

const toUtcHour = (localHour, localDate) => {
  const dtLocal = new Date(`${localDate}T${localHour.padStart(2, '0')}:00:00`);
  return dtLocal.getUTCHours().toString().padStart(2, '0');
};

const getDurationInMinutes = (dep, arr) => {
  if (!dep || !arr) return Infinity;
  const depDate = new Date(dep);
  const arrDate = new Date(arr);
  let diffMins = (arrDate - depDate) / (1000 * 60);
  if (diffMins < 0) diffMins += 24 * 60;
  return diffMins;
};

const formatDurationText = (dep, arr) => {
  if (!dep || !arr) return 'N/A';
  const depDate = new Date(dep);
  const arrDate = new Date(arr);
  let diffMins = (arrDate - depDate) / (1000 * 60);
  if (diffMins < 0) diffMins += 24 * 60; // next day arrival
  const hrs = Math.floor(diffMins / 60);
  const mins = Math.round(diffMins % 60);
  return `${hrs}h ${mins}m`;
};

  // to compare datetime strings, returns true if return is earlier than departure
  const isReturnBeforeDeparture = () => {
    if (tripType == "one-way" || !departureDate || !returnDate) return false;
    const dep = new Date(`${departureDate}T${departureHour.padStart(2, '0')}:00`);
    const ret = new Date(`${returnDate}T${returnHour.padStart(2, '0')}:00`);
    return ret < dep;
  };

    const searchTrips = async () => {
    if (!departureDate) return alert("Please choose a departure date.");
    if (tripType === "roundtrip" && !returnDate) return alert("Please choose a return date for your roundtrip.");

    if (isReturnBeforeDeparture()) {
      return alert("Return date/time cannot be any earlier than departure date/time.");
    }

    try {
      setLoading(true);
      // Outbound Hamburg → Amsterdam
      const utcDepartureHour = toUtcHour(departureHour, departureDate);
      const outboundRes = await fetch(
        `${BASE_URL}/api/trips?is_departure=true&date=${departureDate}&hour=${utcDepartureHour.toString().padStart(2, '0')}`
      );
      const outboundData = await outboundRes.json();
      let journeysOutbound = outboundData.journeys || [];

      if (!outboundRes.ok) {
        alert(outboundData.error);
        setLoading(false);
        return;
      }

      let journeysReturn = [];
      if (tripType === "roundtrip") {
        const utcReturnHour = toUtcHour(returnHour, returnDate);
        const returnRes = await fetch(
          `${BASE_URL}/api/trips?is_departure=false&date=${returnDate}&hour=${utcReturnHour.toString().padStart(2, '0')}`
        );
        const returnData = await returnRes.json();
        journeysReturn = returnData.journeys || [];
      }

      setRawResults({
        outbound: journeysOutbound,
        return: journeysReturn,
      });

    } catch (err) {
      console.error("Failed to fetch trips", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const sortTrips = (trips) => {
      if (sort === "earliest") {
        return trips.slice().sort((a, b) => a.departure_date_time.localeCompare(b.departure_date_time));
      } else if (sort === "fastest") {
        return trips.slice().sort((a, b) => getDurationInMinutes(a.departure_date_time, a.arrival_date_time) - getDurationInMinutes(b.departure_date_time, b.arrival_date_time));
      } else if (sort === "convenient") {
        return trips.slice().sort((a, b) => (a.changes || 0) - (b.changes || 0));
      }
      return trips;
    };

    setResults({
      outbound: sortTrips(rawResults.outbound),
      return: sortTrips(rawResults.return),
    });
  }, [sort, rawResults]);

  const renderTripsTable = (trips, title) => (
    <div className="mt-8 space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      <table className="w-full border-collapse border text-sm shadow-sm">
        <thead className="bg-gray-100">
          <tr>
            <th className="border px-2 py-1">Option</th>
            <th className="border px-2 py-1">Departure</th>
            <th className="border px-2 py-1">Arrival</th>
            <th className="border px-2 py-1">Duration</th>
            <th className="border px-2 py-1">Changes</th>
            <th className="border px-2 py-1">Train Type/Carrier</th>
            {/*<th className="border px-2 py-1">Price</th>*/}
          </tr>
        </thead>
        <tbody>
          {trips.map((trip, index) => (
            <tr key={index} className="text-center bg-white hover:bg-gray-50">
              <td className="border px-2 py-1">#{index + 1}</td>
              <td className="border px-2 py-1">{formatTime(trip.departure_date_time)}</td>
              <td className="border px-2 py-1">{formatTime(trip.arrival_date_time)}</td>
              <td className="border px-2 py-1">{formatDurationText(trip.departure_date_time, trip.arrival_date_time)}</td>
              <td className="border px-2 py-1">{trip.changes}</td>
              <td className="border px-2 py-1">{trip.train || 'N/A'}</td>
              {/*<td className="border px-2 py-1">–</td>*/}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
  <div className="p-6 max-w-4xl mx-auto space-y-4 relative">
    {/* Loading overlay */}
    {loading && (
      <div 
        style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(28, 21, 21, 0.3)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 1000,
          pointerEvents: 'all',
        }}
      >
        <div style={{
          padding: '1rem 2rem',
          backgroundColor: 'black',
          borderRadius: '8px',
          boxShadow: '0 0 10px rgba(0,0,0,0.2)',
          fontSize: '1.25rem',
          fontWeight: 'bold',
        }}>
          Loading...
        </div>
      </div>
    )}

    <div style={{ pointerEvents: loading ? 'none' : 'auto', opacity: loading ? 0.6 : 1 }}>
      <h1 className="text-2xl font-bold">Train Planner: Hamburg ↔ Amsterdam</h1>

      <label className="block">
        Trip type:
        <select
          value={tripType}
          onChange={(e) => setTripType(e.target.value)}
          className="block w-full p-2 border rounded"
          disabled={loading}
        >
          <option value="one-way">One-way</option>
          <option value="roundtrip">Roundtrip</option>
        </select>
      </label>

      <label className="block">
        Departure date:
        <input
          type="date"
          value={departureDate}
          onChange={(e) => setDepartureDate(e.target.value)}
          className="block w-full p-2 border rounded"
          disabled={loading}
        />
      </label>

      <label className="block">
        Departure hour:
        <select
          value={departureHour}
          onChange={e => setDepartureHour(e.target.value)}
          className="block w-full p-2 border rounded"
          disabled={loading}
        >
          {hours.map(h => (
            <option key={h} value={h}>{h}:00</option>
          ))}
        </select>
      </label>

      {tripType === "roundtrip" && (
        <>
          <label className="block">
            Return Date:
            <input
              type="date"
              value={returnDate}
              onChange={e => setReturnDate(e.target.value)}
              className="block w-full p-2 border rounded"
              disabled={loading}
            />
          </label>

          <label className="block">
            Return Hour:
            <select
              value={returnHour}
              onChange={e => setReturnHour(e.target.value)}
              className="block w-full p-2 border rounded"
              disabled={loading}
            >
              {hours.map(h => (
                <option key={h} value={h}>{h}:00</option>
              ))}
            </select>
          </label>
        </>
      )}

      <label className="block">
        Sort by:
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="block w-full p-2 border rounded"
          disabled={loading}
        >
          <option value="fastest">Fastest</option>
          <option value="earliest">Earliest</option>
          {/*<option value="cheapest">Cheapest</option>*/}
          <option value="convenient">Most Convenient</option>
        </select>
      </label>

      <button
        onClick={searchTrips}
        className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        disabled={loading}
      >
        Search Trips
      </button>

      {results.outbound.length > 0 && renderTripsTable(results.outbound, "Outbound Trips")}

      {tripType === "roundtrip" && results.return.length > 0 && renderTripsTable(results.return, "Return Trips")}
    </div>
  </div>
);

}