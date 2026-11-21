# Task 3 — Cleaning Schedules (Firestore only)

1. Back up your currently working project. Extract this ZIP into a new folder.
2. Firebase Console → Firestore Database → Rules: publish the included `firestore.rules` (it retains the existing user and cleaning-history rules).
3. Serve the `Solar-Web-main` directory with `py -m http.server 8001` and open `http://localhost:8001/login.html`.
4. Sign in with an active Client role and open Client Dashboard → Cleaning Schedules.
5. Create a future schedule, verify a document in `cleaningSchedules` in Firestore, then test pause, resume, edit and delete.
6. Confirm Cleaning History and all existing dashboards still work.

## Scope / safety
These schedules are **stored only**; they DO NOT send commands to the ESP32, motor or pump. There is no automatic hardware execution, timezone conversion on the ESP32, missed-job handling, or backend scheduler yet. Dates are entered in the browser's local timezone and saved as Firestore timestamps. Only active Client accounts can create or change their own schedules; active Admin accounts can read schedules. No engineer schedule access is added.

## Notes
Firestore queries are filtered by the logged-in UID and rules independently enforce ownership. New collection indexes should not be required for the simple owner query. Firestore rules must be published before using this module.
