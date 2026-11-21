/**
 * Firebase Authentication + Firestore RBAC for Circuitech Solar Monitoring.
 * Roles are assigned by an administrator in a trusted environment.
 */
(function () {
  'use strict';

  const firebaseConfig = {
    apiKey: "AIzaSyCwpviKRcWii33vVD7VB_LtpOYDr-tU8BA",
    authDomain: "solarpanelmonitoring-930f5.firebaseapp.com",
    projectId: "solarpanelmonitoring-930f5",
    storageBucket: "solarpanelmonitoring-930f5.firebasestorage.app",
    messagingSenderId: "863863734019",
    appId: "1:863863734019:web:7824d6145aae108d6db336",
    measurementId: "G-MMKM7N0P94"
  };

  if (!window.firebase) {
    console.error("Firebase SDK did not load.");
    return;
  }
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  const auth = firebase.auth();
  const db = firebase.firestore();
  const ROLE_PAGES = {
    client: 'dashboard.html',
    admin: 'admin-dashboard.html',
    engineer: 'engineer-dashboard.html'
  };

  function normalizeRoles(profile) {
    const values = Array.isArray(profile && profile.roles)
      ? profile.roles
      : (profile && typeof profile.role === 'string' ? [profile.role] : []);
    return [...new Set(values.map(value => String(value).toLowerCase())
      .filter(value => Object.prototype.hasOwnProperty.call(ROLE_PAGES, value)))];
  }

  function landingPage(roles) {
    if (!roles.length) return 'pending-approval.html';
    if (roles.length === 1) return ROLE_PAGES[roles[0]];
    return 'select-dashboard.html';
  }

  function safeNextPage(role) {
    return ROLE_PAGES[role] || 'login.html';
  }

  async function getOrCreateProfile(user) {
    const ref = db.collection('users').doc(user.uid);
    const snap = await ref.get();
    const now = firebase.firestore.FieldValue.serverTimestamp();

    if (!snap.exists) {
      // Public registration never grants a role. An admin must approve and assign it.
      await ref.set({
        uid: user.uid,
        displayName: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || '',
        provider: (user.providerData || []).map(p => p.providerId).join('+') || 'password',
        role: null,
        status: 'pending',
        createdAt: now,
        lastLoginAt: now
      });
    } else {
      // Update identity metadata only. Never overwrite role/status/createdAt here.
      await ref.set({
        uid: user.uid,
        displayName: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || '',
        provider: (user.providerData || []).map(p => p.providerId).join('+') || 'password',
        lastLoginAt: now
      }, { merge: true });
    }

    const updated = await ref.get();
    return updated.data();
  }

  async function signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    const result = await auth.signInWithPopup(provider);
    if (!result.user) throw new Error('Google sign-in did not return a user.');

    const profile = await getOrCreateProfile(result.user);
    const roles = normalizeRoles(profile);
    const role = roles.length === 1 ? roles[0] : (roles.includes('admin') ? 'admin' : null);
    const status = typeof profile.status === 'string' ? profile.status.toLowerCase() : 'pending';

    // Retain compatibility with the existing dashboard's display/session utilities.
    if (window.SecurityDB && typeof window.SecurityDB.setSession === 'function') {
      window.SecurityDB.setSession({
        name: result.user.displayName || result.user.email || 'User',
        email: result.user.email || '',
        role: role || (roles.length > 1 ? 'multi-role' : 'pending'),
        roles,
        source: 'Firebase Google Authentication',
        uid: result.user.uid,
        photoURL: result.user.photoURL || ''
      });
    }

    return { user: result.user, profile, role, roles, status, redirect: landingPage(roles) };
  }

  async function selectDashboard(role) {
    const profile = await getCurrentProfile();
    const roles = normalizeRoles(profile);
    const status = profile && String(profile.status || '').toLowerCase();
    if (status !== 'active' || !roles.includes(role)) {
      throw new Error('This account is not assigned the selected dashboard role.');
    }
    return ROLE_PAGES[role];
  }

  async function getCurrentProfile() {
    const user = auth.currentUser;
    if (!user) return null;
    const snap = await db.collection('users').doc(user.uid).get();
    return snap.exists ? snap.data() : null;
  }

  // Store a cleaning event in Firestore. Browser-originated records are explicitly
  // marked as simulated until the ESP32 is connected through a trusted backend.
  async function recordCleaningHistory(event) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in to record cleaning history.');

    const profile = await getCurrentProfile();
    const roles = normalizeRoles(profile);
    if (!profile || String(profile.status || '').toLowerCase() !== 'active' || !roles.includes('client')) {
      throw new Error('An active client account is required to record cleaning history.');
    }

    const allowedModes = ['manual', 'auto'];
    const allowedOutcomes = ['completed', 'stopped'];
    if (!event || !allowedModes.includes(event.mode) || !allowedOutcomes.includes(event.outcome)) {
      throw new Error('Invalid cleaning history event.');
    }

    const startedAt = event.startedAt instanceof Date ? event.startedAt : new Date(event.startedAt);
    const completedAt = event.completedAt instanceof Date ? event.completedAt : new Date(event.completedAt);
    const durationSeconds = Number(event.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0 || !Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime())) {
      throw new Error('Cleaning event contains invalid timing information.');
    }

    const record = {
      userId: user.uid,
      userEmail: user.email || '',
      userName: profile.displayName || user.displayName || '',
      mode: event.mode,
      triggerReason: String(event.triggerReason || (event.mode === 'manual' ? 'manual_request' : 'automatic_threshold')).slice(0, 120),
      outcome: event.outcome,
      durationSeconds: Math.round(durationSeconds * 10) / 10,
      dustDistanceBefore: event.dustDistanceBefore != null && Number.isFinite(Number(event.dustDistanceBefore)) ? Number(event.dustDistanceBefore) : null,
      humidityAtCleaning: event.humidityAtCleaning != null && Number.isFinite(Number(event.humidityAtCleaning)) ? Number(event.humidityAtCleaning) : null,
      startedAt: firebase.firestore.Timestamp.fromDate(startedAt),
      completedAt: firebase.firestore.Timestamp.fromDate(completedAt),
      source: 'dashboard-simulation',
      isSimulated: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('cleaningHistory').add(record);
    return ref.id;
  }

  // Fetch cleaning history according to the signed-in user's verified role.
  // Clients are always constrained to their own UID; admins and engineers can
  // review all records for the current single-panel prototype.
  async function getCleaningHistory(limit = 100) {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in to view cleaning history.');
    const profile = await getCurrentProfile();
    const roles = normalizeRoles(profile);
    if (!profile || String(profile.status || '').toLowerCase() !== 'active') {
      throw new Error('An active account is required to view cleaning history.');
    }

    let query = db.collection('cleaningHistory');
    if (roles.includes('admin') || roles.includes('engineer')) {
      // Admin and Engineer: all prototype records. Firestore rules enforce this.
    } else if (roles.includes('client')) {
      query = query.where('userId', '==', user.uid);
    } else {
      throw new Error('Your account is not authorised to view cleaning history.');
    }
    const snap = await query.orderBy('completedAt', 'desc').limit(limit).get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  // Engineer maintenance records: these are human-entered service logs, not hardware telemetry.
  async function requireMaintenanceRole() {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    const profile = await getCurrentProfile();
    const roles = normalizeRoles(profile);
    if (!profile || String(profile.status || '').toLowerCase() !== 'active' || !(roles.includes('engineer') || roles.includes('admin'))) {
      throw new Error('An active Engineer or Admin account is required.');
    }
    return { user, profile, roles };
  }

  async function createMaintenanceRecord(input) {
    const { user, profile, roles } = await requireMaintenanceRole();
    if (!roles.includes('engineer')) throw new Error('Only Engineers can create maintenance records.');
    const allowedCategories = ['inspection', 'cleaning-mechanism', 'sensor', 'connectivity', 'electrical', 'other'];
    const allowedStatuses = ['open', 'in-progress', 'resolved'];
    const title = String(input && input.title || '').trim().slice(0, 100);
    const description = String(input && input.description || '').trim().slice(0, 1500);
    const category = String(input && input.category || 'other');
    const status = String(input && input.status || 'open');
    if (!title || !description || !allowedCategories.includes(category) || !allowedStatuses.includes(status)) {
      throw new Error('Enter a title and description, and choose valid category and status values.');
    }
    const ref = await db.collection('maintenanceRecords').add({
      engineerUid: user.uid,
      engineerName: profile.displayName || user.displayName || user.email || 'Engineer',
      engineerEmail: user.email || '',
      title, description, category, status,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  async function getMaintenanceRecords(limit = 100) {
    const { roles } = await requireMaintenanceRole();
    let query = db.collection('maintenanceRecords');
    if (!roles.includes('admin')) query = query.where('engineerUid', '==', auth.currentUser.uid);
    const snap = await query.orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  async function updateMaintenanceRecord(id, changes) {
    const { user, roles } = await requireMaintenanceRole();
    if (!roles.includes('engineer')) throw new Error('Only Engineers can update maintenance records.');
    const allowedStatuses = ['open', 'in-progress', 'resolved'];
    if (!id || !allowedStatuses.includes(changes.status)) throw new Error('Invalid maintenance status.');
    const ref = db.collection('maintenanceRecords').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data().engineerUid !== user.uid) throw new Error('Record not found or access denied.');
    await ref.update({ status: changes.status, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }

  // Dashboard-only schedule management. No hardware command is issued here.
  async function requireScheduleClient() {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    const profile = await getCurrentProfile();
    if (!profile || profile.status !== 'active' || !normalizeRoles(profile).includes('client')) {
      throw new Error('An active Client role is required.');
    }
    return user;
  }

  function validateScheduleInput(input) {
    const when = new Date(input.scheduledFor);
    if (!Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) {
      throw new Error('Choose a valid future date and time.');
    }
    if (when.getTime() > Date.now() + 366 * 24 * 3600 * 1000) {
      throw new Error('Schedules can be created up to one year ahead.');
    }
    return firebase.firestore.Timestamp.fromDate(when);
  }

  async function createCleaningSchedule(input) {
    const user = await requireScheduleClient();
    const scheduledFor = validateScheduleInput(input);
    const ref = await db.collection('cleaningSchedules').add({
      userId: user.uid,
      scheduledFor,
      status: 'active',
      mode: 'manual-scheduled',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  async function getCleaningSchedules() {
    const user = await requireScheduleClient();
    const snapshot = await db.collection('cleaningSchedules').where('userId', '==', user.uid).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => a.scheduledFor.toMillis() - b.scheduledFor.toMillis());
  }

  async function updateCleaningSchedule(id, changes) {
    await requireScheduleClient();
    if (typeof id !== 'string' || !id) throw new Error('Missing schedule ID.');
    const ref = db.collection('cleaningSchedules').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new Error('Schedule not found.');
    const current = snapshot.data();
    if (current.userId !== auth.currentUser.uid) throw new Error('Access denied.');
    const update = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (Object.prototype.hasOwnProperty.call(changes, 'scheduledFor')) {
      update.scheduledFor = validateScheduleInput(changes);
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'status')) {
      if (!['active', 'paused'].includes(changes.status)) throw new Error('Invalid schedule status.');
      update.status = changes.status;
    }
    await ref.update(update);
  }

  async function deleteCleaningSchedule(id) {
    await requireScheduleClient();
    const ref = db.collection('cleaningSchedules').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return;
    if (snapshot.data().userId !== auth.currentUser.uid) throw new Error('Access denied.');
    await ref.delete();
  }

  function waitForAuthState() {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise(resolve => {
      const unsubscribe = auth.onAuthStateChanged(user => {
        unsubscribe();
        resolve(user);
      });
    });
  }

  async function requireRole(allowedRole) {
    const user = await waitForAuthState();
    if (!user) {
      window.location.replace('login.html?restricted=1');
      return false;
    }

    try {
      const profile = await getCurrentProfile();
      const roles = normalizeRoles(profile);
      const status = profile && typeof profile.status === 'string' ? profile.status.toLowerCase() : 'pending';

      if (status !== 'active' || roles.length === 0) {
        window.location.replace('pending-approval.html');
        return false;
      }
      if (allowedRole && !roles.includes(allowedRole)) {
        window.location.replace(landingPage(roles));
        return false;
      }
      return true;
    } catch (error) {
      console.error("Could not verify the user role:", error);
      window.location.replace('login.html?restricted=1');
      return false;
    }
  }

  async function signOut() {
    if (window.SecurityDB && typeof window.SecurityDB.logout === 'function') {
      // SecurityDB.logout also signs out Firebase.
      window.SecurityDB.logout();
    } else {
      await auth.signOut();
    }
  }


  async function signInWithEmail(email, password) {
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    const result = await auth.signInWithEmailAndPassword(email, password);
    const profile = await getOrCreateProfile(result.user);
    const roles = normalizeRoles(profile);
    const role = roles.length === 1 ? roles[0] : (roles.includes('admin') ? 'admin' : null);
    const status = typeof profile.status === 'string' ? profile.status.toLowerCase() : 'pending';
    if (window.SecurityDB && typeof window.SecurityDB.setSession === 'function') {
      window.SecurityDB.setSession({
        name: result.user.displayName || result.user.email || 'User',
        email: result.user.email || '',
        role: role || (roles.length > 1 ? 'multi-role' : 'pending'),
        roles,
        source: 'Firebase Email/Password Authentication',
        uid: result.user.uid,
        photoURL: result.user.photoURL || ''
      });
    }
    return { user: result.user, profile, role, roles, status, redirect: landingPage(roles) };
  }

  async function registerWithEmail(name, email, password) {
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    const result = await auth.createUserWithEmailAndPassword(email, password);
    if (name && result.user.updateProfile) {
      await result.user.updateProfile({ displayName: name });
    }
    const profile = await getOrCreateProfile(result.user);
    return { user: result.user, profile, role: null, status: 'pending', redirect: 'pending-approval.html' };
  }

  // For an existing Google-authenticated account, link a password to the SAME
  // Firebase UID instead of creating a duplicate account for the same email.
  async function linkPasswordToGoogleAccount(email, password) {
    const result = await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    const user = result.user;
    if (!user || !user.email || user.email.toLowerCase() !== email.toLowerCase()) {
      await auth.signOut();
      throw new Error('Choose the same Google account as the email address entered above.');
    }
    const credential = firebase.auth.EmailAuthProvider.credential(email, password);
    await user.linkWithCredential(credential);
    const profile = await getOrCreateProfile(user);
    const roles = normalizeRoles(profile);
    const role = roles.length === 1 ? roles[0] : (roles.includes('admin') ? 'admin' : null);
    const status = typeof profile.status === 'string' ? profile.status.toLowerCase() : 'pending';
    return { user, profile, role, roles, status, redirect: landingPage(roles) };
  }


  // One-shot hardware cleaning command queue. The browser creates a command;
  // the authenticated ESP32 engineer account claims it and reports completion.
  async function queueHardwareCleaningCommand() {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in before requesting a cleaning cycle.');
    const profile = await getCurrentProfile();
    const roles = normalizeRoles(profile);
    if (!profile || String(profile.status || '').toLowerCase() !== 'active' || !roles.includes('client')) {
      throw new Error('An active Client account is required.');
    }
    const ref = db.collection('cleaningCommands').doc();
    await ref.set({
      userId: user.uid,
      userEmail: user.email || '',
      deviceId: 'solarsense-01',
      command: 'CLEAN_ONCE',
      status: 'queued',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  async function requestHardwareStop(commandId) {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in first.');
    const ref = db.collection('cleaningCommands').doc(commandId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().userId !== user.uid) throw new Error('Command not found or access denied.');
    if (!['queued', 'running'].includes(snap.data().status)) throw new Error('This command is no longer active.');
    await ref.update({ status: 'stop-requested' });
  }

  function watchHardwareCleaningCommand(commandId, onChange, onError) {
    if (!commandId || typeof onChange !== 'function') throw new Error('A command ID and callback are required.');
    return db.collection('cleaningCommands').doc(commandId).onSnapshot(snapshot => {
      if (!snapshot.exists) {
        onError && onError(new Error('Cleaning command no longer exists.'));
        return;
      }
      onChange({ id: snapshot.id, ...snapshot.data() });
    }, error => onError && onError(error));
  }

  window.FirebaseServices = {
    auth,
    firestore: db,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    linkPasswordToGoogleAccount,
    getCurrentProfile,
    recordCleaningHistory,
    queueHardwareCleaningCommand,
    requestHardwareStop,
    watchHardwareCleaningCommand,
    getCleaningHistory,
    createCleaningSchedule,
    getCleaningSchedules,
    updateCleaningSchedule,
    deleteCleaningSchedule,
    createMaintenanceRecord,
    getMaintenanceRecords,
    updateMaintenanceRecord,
    normalizeRoles,
    selectDashboard,
    requireRole,
    signOut,
    rolePages: ROLE_PAGES
  };
})();
