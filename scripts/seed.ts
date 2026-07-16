// `npm run seed` — reset the local database to a fresh rolling demo calendar.
//
// The seed data + logic live in lib/seed.ts so they can be shared with the
// demo-reset route. This script is a thin CLI wrapper around runSeed().
//
// Scripts use RELATIVE imports with `.js` extensions because tsx runs them
// outside the Next.js/tsconfig path resolution. `./load-env.js` MUST come first:
// it loads .env.local before lib/seed.js pulls in lib/db.ts, which reads the DB
// URL from process.env at import time.
import "./load-env.js";
import { runSeed } from "../lib/seed.js";

runSeed()
  .then((counts) => {
    console.log("Seed complete:");
    console.log(`  slots:      ${counts.slots}`);
    console.log(`  free:       ${counts.free}`);
    console.log(`  pre-booked: ${counts.prebooked}`);
    console.log(`  bookings:   0`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
