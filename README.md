# Smart Train Finder

A web application to search train trips between Hamburg and Amsterdam.  
Backend uses Deutsche Bahn API for timetable data.  
Frontend is a React app.

## Features

- Search one-way or roundtrip train trips
- Select departure and return dates and times  
- View detailed trips with departure, arrival, duration, train type etc. 

## Setup

1. Clone this repo  
2. Create a `.env` file in the `backend` folder with: 

DB_CLIENT_ID=your_db_client_id
DB_API_KEY=your_db_api_key

More information on how to create your key can be found in https://developers.deutschebahn.com/db-api-marketplace/apis/marketplace

3. Install backend dependencies:
../smart-train-finder/backend $ npm install

4. Install frontend dependencies and build frontend: 
../smart-train-finder/frontend $ npm install
../smart-train-finder/frontend $ npm run build (note down local and port here)

5. Start backend server:
../smart-train-finder/backend $ npm start

6. Open browser and visit local in step 4




USAGE
Edit input as desired (trip type, dates and times, sort by)

NOTES:
Price data is not available as DeutscheBahn API doesn't provide.
Return date and time can be edited only if roundtrip is selected.
API Data availability depends on DB API. You can always check https://developers.deutschebahn.com/db-api-marketplace/apis/product/timetables/api/17423#/Timetables_10213/operation/%2Fplan%2F{evaNo}%2F{date}%2F{hour}/get to double check data from DB API.
