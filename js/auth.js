/**
 * Firebase authentication UI: Google + Email/Password.
 * Roles remain controlled by Firestore and are never selected at registration.
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    if (loginForm) loginForm.style.display = '';
    if (registerForm) registerForm.style.display = '';

    setupEmailLogin(loginForm);
    setupRegistration(registerForm);
    setupGoogleSignIn();
    setupPasswordToggles();
    updateGlobalNavAuth();

    const params = new URLSearchParams(window.location.search);
    if (params.get('restricted') === '1') {
      showBanner(document.getElementById('auth-error-banner'),
        'Please sign in with an approved account to continue.');
    }
  }

  function handleResult(result) {
    const errorBanner = document.getElementById('auth-error-banner');
    const successBanner = document.getElementById('auth-success-banner');
    if (result.status !== 'active' || !result.role) {
      showBanner(errorBanner, 'Your account is awaiting administrator approval.');
      setTimeout(() => window.location.replace('pending-approval.html'), 700);
      return;
    }
    const roles = Array.isArray(result.roles) ? result.roles : (result.role ? [result.role] : []);
    const destination = result.redirect || (roles.length > 1 ? 'select-dashboard.html' : 'dashboard.html');
    showBanner(successBanner, roles.length > 1
      ? 'Signed in. Choose which dashboard to open.'
      : 'Signed in. Opening your ' + roles[0] + ' dashboard...');
    setTimeout(() => window.location.replace(destination), 500);
  }

  function setupEmailLogin(form) {
    if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const email = value('login-email');
      const password = value('login-password');
      const button = document.getElementById('login-submit');
      setBusy(button, true, 'Signing in...');
      clearBanners();
      try {
        const result = await window.FirebaseServices.signInWithEmail(email, password);
        handleResult(result);
      } catch (error) {
        console.error('Email/password sign-in failed:', error);
        showBanner(document.getElementById('auth-error-banner'), friendlyError(error));
      } finally {
        setBusy(button, false, 'Authenticate Credentials');
      }
    });
  }

  function setupRegistration(form) {
    if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const name = value('reg-name');
      const email = value('reg-email');
      const password = value('reg-password');
      const confirm = value('reg-confirm');
      if (password.length < 8) {
        showBanner(document.getElementById('auth-error-banner'), 'Use a password with at least 8 characters.');
        return;
      }
      if (password !== confirm) {
        showBanner(document.getElementById('auth-error-banner'), 'The passwords do not match.');
        return;
      }
      const button = document.getElementById('reg-submit');
      setBusy(button, true, 'Creating account...');
      clearBanners();
      try {
        await window.FirebaseServices.registerWithEmail(name, email, password);
        showBanner(document.getElementById('auth-success-banner'),
          'Account created. Your access is pending administrator approval.');
        setTimeout(() => window.location.replace('pending-approval.html'), 900);
      } catch (error) {
        console.error('Registration failed:', error);
        showBanner(document.getElementById('auth-error-banner'), friendlyError(error));
      } finally {
        setBusy(button, false, 'Create Account');
      }
    });
  }

  function setupGoogleSignIn() {
    const button = document.getElementById('google-signin-button');
    if (!button) return;
    button.addEventListener('click', async () => {
      clearBanners();
      setBusy(button, true, 'Connecting to Google...');
      try {
        const result = await window.FirebaseServices.signInWithGoogle();
        handleResult(result);
      } catch (error) {
        console.error('Google sign-in failed:', error);
        showBanner(document.getElementById('auth-error-banner'), friendlyError(error));
      } finally {
        setBusy(button, false);
      }
    });
  }

  function setupPasswordLink() {
    const button = document.getElementById('link-password-button');
    if (!button) return;
    button.addEventListener('click', async () => {
      const email = value('link-email');
      const password = value('link-password');
      if (!email || password.length < 8) {
        showBanner(document.getElementById('auth-error-banner'),
          'Enter your account email and a new password of at least 8 characters.');
        return;
      }
      clearBanners();
      setBusy(button, true, 'Verifying Google account...');
      try {
        const result = await window.FirebaseServices.linkPasswordToGoogleAccount(email, password);
        showBanner(document.getElementById('auth-success-banner'),
          'Password linked to your existing Google account. You can now use either sign-in method.');
        if (result.status === 'active' && result.role) {
          setTimeout(() => window.location.replace(result.redirect), 900);
        }
      } catch (error) {
        console.error('Password linking failed:', error);
        showBanner(document.getElementById('auth-error-banner'), friendlyError(error));
      } finally {
        setBusy(button, false);
      }
    });
  }

  function setupPasswordToggles() {
    document.querySelectorAll('.toggle-password').forEach(button => {
      button.addEventListener('click', () => {
        const input = button.parentElement.querySelector('input');
        if (input) input.type = input.type === 'password' ? 'text' : 'password';
      });
    });
  }

  function updateGlobalNavAuth() {
    const container = document.getElementById('nav-auth-container');
    const auth = window.FirebaseServices && window.FirebaseServices.auth;
    if (!container || !auth) return;
    auth.onAuthStateChanged(async user => {
      if (!user) {
        container.innerHTML = '<a href="login.html" class="nav-auth">Sign In</a>';
        return;
      }
      try {
        const profile = await window.FirebaseServices.getCurrentProfile();
        const name = profile && profile.displayName ? profile.displayName : (user.email || 'User');
        const roles = window.FirebaseServices.normalizeRoles(profile);
        const role = roles.length ? roles.join(' / ') : 'pending';
        container.innerHTML = `<div class="nav-user"><span class="nav-user-name">${escapeHTML(name)} · ${escapeHTML(role)}</span><button id="btn-global-logout" class="btn-logout" type="button">Sign Out</button></div>`;
        const logout = document.getElementById('btn-global-logout');
        if (logout) logout.addEventListener('click', async () => {
          await window.FirebaseServices.signOut();
          window.location.replace('login.html');
        });
      } catch (error) { console.warn('Could not load navigation profile:', error); }
    });
  }

  function value(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }
  function setBusy(button, busy, text) {
    if (!button) return;
    button.disabled = busy;
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    if (busy && text) {
      const span = button.querySelector('.btn-text');
      if (span) span.textContent = text;
      else button.textContent = text;
    } else if (!busy) {
      button.innerHTML = button.dataset.originalHtml;
    }
  }
  function clearBanners() {
    hideBanner(document.getElementById('auth-error-banner'));
    hideBanner(document.getElementById('auth-success-banner'));
  }
  function showBanner(el, message) {
    if (!el) return;
    el.textContent = message;
    el.classList.add('visible');
  }
  function hideBanner(el) {
    if (!el) return;
    el.textContent = '';
    el.classList.remove('visible');
  }
  function friendlyError(error) {
    const code = error && error.code;
    const messages = {
      'auth/invalid-credential': 'Email or password is incorrect.',
      'auth/wrong-password': 'Email or password is incorrect.',
      'auth/user-not-found': 'No account exists with this email. Register first or use Google Sign-In.',
      'auth/email-already-in-use': 'This email already has a Firebase account. If it is your existing Google account, use the password-link option below.',
      'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
      'auth/invalid-email': 'Enter a valid email address.',
      'auth/account-exists-with-different-credential': 'This email is already registered with another sign-in provider. Sign in with that provider first.',
      'auth/provider-already-linked': 'A password is already linked to this account. Try signing in with email and password.',
      'auth/credential-already-in-use': 'That password credential is already linked to another Firebase account.',
      'auth/unauthorized-domain': 'This domain is not authorized in Firebase Authentication settings.',
      'auth/popup-blocked': 'The browser blocked the Google popup. Allow popups and try again.',
      'permission-denied': 'Firestore denied the profile operation. Check the published Firestore rules.'
    };
    return messages[code] || (error && error.message) || 'Authentication failed. Check the browser console for details.';
  }
  function escapeHTML(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }
})();
