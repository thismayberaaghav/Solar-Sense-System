# Task 4 — Engineer Maintenance Records

## What this adds
- Engineers can create maintenance records from the Engineer Dashboard.
- Records are stored in the Firestore `maintenanceRecords` collection.
- Engineers can view their own records and update status (Open / In progress / Resolved).
- Admins can view all engineer maintenance records.
- Clients do not receive access to this collection.

## Firestore rules
Publish the included `firestore.rules` in Firebase Console → Firestore Database → Rules. The rules permit active Engineers to create/read their own records and update only status; active Admins can read all records. Deletes are disabled.

## Test
1. Sign in as an active Engineer.
2. Create a record with a title, category, findings/action, and status.
3. Confirm a document appears in `maintenanceRecords`.
4. Change its status and confirm Firestore updates.
5. Sign in as Admin and confirm the record appears in Engineer Maintenance Records.
6. Confirm a Client cannot read this collection.

These are manually entered service records. They do not automatically detect faults or control hardware.
