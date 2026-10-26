(function () {
  firebase.initializeApp(window.VYRO_FIREBASE_CONFIG);
  var auth = firebase.auth();
  var db = firebase.firestore();
  var stamp = firebase.firestore.FieldValue.serverTimestamp;
  var busy = false;

  function friendly(err) {
    var map = {
      'auth/email-already-in-use': 'That email already has an account. Try signing in.',
      'auth/invalid-email': 'That email address does not look right.',
      'auth/weak-password': 'Choose a stronger password (at least 8 characters).',
      'auth/invalid-credential': 'Email or password is incorrect.',
      'auth/wrong-password': 'Email or password is incorrect.',
      'auth/user-not-found': 'Email or password is incorrect.',
      'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
      'auth/network-request-failed': 'No connection. Check your internet and try again.',
      'permission-denied': 'Permission denied. Check the Firestore rules were published, or you may not have access.',
      'vyro/no-business': 'No business found for this account. You may have been removed from the team.'
    };
    return map[err && err.code] || 'Something went wrong. Please try again.';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  async function signUp(email, password, businessName, product) {
    busy = true;
    try {
      var cred = await auth.createUserWithEmailAndPassword(email, password);
      try {
        var uid = cred.user.uid;
        var bizRef = db.collection('businesses').doc();
        var batch = db.batch();
        batch.set(bizRef, { name: businessName, ownerUid: uid, product: product || 'contractor', createdAt: stamp() });
        batch.set(bizRef.collection('members').doc(uid), { role: 'owner', email: email, createdAt: stamp() });
        batch.set(db.collection('users').doc(uid), { email: email, bizId: bizRef.id, createdAt: stamp() });
        await batch.commit();
      } catch (e) {
        try { await cred.user.delete(); } catch (_) {}
        throw e;
      }
      return cred.user;
    } finally { busy = false; }
  }

  function randomPassword() {
    var a = new Uint8Array(24); crypto.getRandomValues(a);
    return Array.from(a, function (x) { return x.toString(36).padStart(2, '0'); }).join('') + 'Aa1!';
  }

  // Firebase emails a link that lets the person choose their own password.
  async function sendLoginEmail(email) {
    try {
      await auth.sendPasswordResetEmail(email, { url: location.origin + '/login.html' });
    } catch (e) {
      await auth.sendPasswordResetEmail(email);
    }
  }

  // Owner or supervisor adds a team member. The new login gets a random password nobody sees.
  async function addMember(bizId, email, name, role, extra) {
    var app2 = firebase.initializeApp(window.VYRO_FIREBASE_CONFIG, 'second-' + Date.now());
    var a2 = app2.auth();
    var d2 = app2.firestore();
    var uid = null;
    try {
      await a2.setPersistence(firebase.auth.Auth.Persistence.NONE);
      var cred = await a2.createUserWithEmailAndPassword(email, randomPassword());
      uid = cred.user.uid;
      try {
        await d2.collection('users').doc(uid).set({ email: email, bizId: bizId, createdAt: stamp() });
        var mdoc = { role: role, email: email, name: name, addedBy: auth.currentUser.uid, createdAt: stamp() };
        if (extra) { Object.keys(extra).forEach(function (k) { mdoc[k] = extra[k]; }); }
        await db.collection('businesses').doc(bizId).collection('members').doc(uid).set(mdoc);
      } catch (e) {
        try { await d2.collection('users').doc(uid).delete(); } catch (_) {}
        try { await cred.user.delete(); } catch (_) {}
        throw e;
      }
      var emailSent = true;
      try { await sendLoginEmail(email); } catch (e) { emailSent = false; }
      return { uid: uid, emailSent: emailSent };
    } finally {
      try { await a2.signOut(); } catch (_) {}
      try { await app2.delete(); } catch (_) {}
    }
  }

  function signIn(email, password) { return auth.signInWithEmailAndPassword(email, password); }
  function resetPassword(email) { return auth.sendPasswordResetEmail(email); }
  function signOut() { try { sessionStorage.removeItem('vyroHelp'); } catch (e) { /* ignore */ } return auth.signOut(); }

  function requireAuth(cb) {
    auth.onAuthStateChanged(function (u) {
      if (!u) { location.replace('/login.html'); } else { cb(u); }
    });
  }
  function redirectIfSignedIn() {
    auth.onAuthStateChanged(async function (u) {
      if (!u || busy) return;
      // Everyone who signs in goes to the restaurant home.
      var dest = '/index.html';
      location.replace(dest);
    });
  }

  async function loadContext(user) {
    var u = await db.collection('users').doc(user.uid).get();
    if (!u.exists || !u.data().bizId) { throw { code: 'vyro/no-business' }; }
    var bizRef = db.collection('businesses').doc(u.data().bizId);
    var res = await Promise.all([bizRef.get(), bizRef.collection('members').doc(user.uid).get()]);
    if (!res[0].exists || !res[1].exists) { throw { code: 'vyro/no-business' }; }
    return { user: user, bizId: bizRef.id, bizRef: bizRef, biz: res[0].data(), me: res[1].data(), role: res[1].data().role };
  }

  // Sign-in required, then loads the business. Errors show in the element with id="err".
  function start(cb) {
    requireAuth(async function (user) {
      try {
        var ctx = await loadContext(user);
        if (window.VYRO_STAFF_ONLY && ctx.role !== 'owner' && ctx.role !== 'supervisor') {
          Array.prototype.forEach.call(document.querySelectorAll('.wrap > *'), function (n) {
            if (!n.classList.contains('brand') && !n.classList.contains('back') && n.id !== 'err') n.style.display = 'none';
          });
          var ee = document.getElementById('err');
          if (ee) ee.textContent = 'Only the owner or a supervisor can use this page.';
          return;
        }
        await cb(ctx);
      } catch (err) {
                var e = document.getElementById('err');
        if (e) { e.textContent = friendly(err); }
      }
    });
  }

  // Change log (best effort). Owners can read it in the rules; nobody can edit or delete entries.
  function audit(ctx, action, detail) {
    try {
      return ctx.bizRef.collection('audit').add({
        action: String(action).slice(0, 60), detail: String(detail || '').slice(0, 300),
        by: ctx.user.uid, byEmail: ctx.user.email || '', role: ctx.role, at: stamp()
      }).catch(function () { /* never block the real action */ });
    } catch (e) { return Promise.resolve(); }
  }

  window.vyro = { audit: audit, auth: auth, db: db, stamp: stamp, friendly: friendly, el: el,
    signUp: signUp, addMember: addMember, sendLoginEmail: sendLoginEmail,
    signIn: signIn, resetPassword: resetPassword, signOut: signOut,
    requireAuth: requireAuth, redirectIfSignedIn: redirectIfSignedIn,
    loadContext: loadContext, start: start };

})();
