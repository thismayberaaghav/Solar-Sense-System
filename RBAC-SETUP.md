
# Firebase RBAC implementation notes

This project now uses Firebase Google Authentication + Cloud Firestore roles.

## Roles and routes
- `client` -> `dashboard.html` (existing ThingSpeak telemetry dashboard)
- `admin` -> `admin-dashboard.html`
- `engineer` -> `engineer-dashboard.html`
- Missing role or non-active account -> `pending-approval.html`

## First administrator
The first administrator is bootstrapped manually in Firebase Console. The existing user document must contain:
- `role` (string): `admin`
- `status` (string): `active`

The current project's first administrator was configured this way before these changes.

## Firestore rules
Review `firestore.rules` and publish them in Firebase Console -> Firestore Database -> Rules.
The rules allow new users to create only pending profiles. Users cannot update their own role/status. Active admins can read and update user documents to assign roles.

Do not publish rules until confirming that the first admin document has lowercase `role: "admin"` and `status: "active"`.

## New users
A first-time Google sign-in creates `/users/{Firebase UID}` with `role: null` and `status: "pending"`. An admin must manually assign `client`, `engineer`, or `admin` and set `status: "active"` in Firestore. Admin UI for assigning roles is a later implementation step.

## Authentication
Google Sign-In and Firebase Email/Password are enabled. New email/password registrations create Firebase Auth accounts and pending Firestore profiles. Existing Google users should use the login page's "Sign in with Google & Link Password" flow once to link a password to their existing Firebase account and preserve the same UID/role. This does not recover or import a password from the previous local/Supabase authentication system; users choose a new Firebase password. Existing Supabase telemetry/history integrations remain in the project.

## Important security boundary
Frontend role checks control navigation and user experience, but Firestore Security Rules enforce database access. Do not rely on hidden pages or JavaScript checks alone. The existing client telemetry dashboard is protected by a client-role check. Admin/engineer pages are currently role-protected starter pages; their operational features still need to be built.

## Email/password setup
In Firebase Console -> Authentication -> Sign-in method, enable the Email/Password provider. The Google provider should remain enabled. The login page supports email/password sign-in and Google sign-in. New email/password registration is also available.

## Multiple roles for one account
For a user who needs more than one workspace, set a `roles` array on their existing `/users/{uid}` document, e.g. `roles: ['admin', 'client', 'engineer']`, and `status: 'active'`. The login flow routes multi-role accounts to `select-dashboard.html`. Keep role assignment restricted to trusted admins; do not allow users to edit `roles` themselves. The legacy single `role` field remains supported for single-role accounts.


## Cleaning History (Firestore)

The client dashboard writes simulated cleaning events to the top-level `cleaningHistory` collection. Each record includes the authenticated user's UID, mode, trigger reason, outcome, duration, pre-cleaning dust/humidity readings, timestamps, and `isSimulated: true`. These events are explicitly marked as browser simulations because the current dashboard uses an 8-second simulated cycle; they are not proof that the physical ESP32/wiper completed a cleaning cycle.

The Firestore rules allow an active client to create only their own simulation records, allow users to read their own records, and allow active admins to read all records. Records cannot be edited or deleted from the client. Deploy the updated `firestore.rules` before testing Firestore writes. Hardware-originated events should later be written through a trusted backend/Cloud Function, not by placing privileged credentials in ESP32 firmware.
