import fetch from "node-fetch";
import { ST_API_KEY } from "./src/config.js";

async function main() {
  const url = "https://data.solanatracker.io/top-traders?window=3d&limit=5";

  try {
    const res = await fetch(url, {
      headers: { "x-api-key": ST_API_KEY }
    });

    console.log("Status:", res.status, res.statusText);

    const text = await res.text(); // get raw text first
    console.log("Raw response:\n", text);
  } catch (err) {
    console.error("Error:", err);
  }
}

main();
