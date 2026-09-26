import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

// Real authentication via Firebase Auth (Email/Password), not a client-side doc compare.
// Setup (Firebase console): Authentication -> Sign-in method -> enable Email/Password,
// then add ONE user (e.g. admin@example.com with your password). No password or
// credentials doc lives in Firestore — rules (request.auth != null) now enforce access.

export function initAuth(callback) {
  return onAuthStateChanged(getAuth(), callback);
}

// Current signed-in user's uid — used to scope every session/message path so each
// user has an isolated chat history (users/{uid}/sessions/...).
export function currentUid() {
  const uid = getAuth().currentUser?.uid;
  if (!uid) throw new Error("Not signed in — no Firebase user.");
  return uid;
}

export async function login(email, password) {
  await signInWithEmailAndPassword(getAuth(), email.trim(), password);
}

export async function logout() {
  await signOut(getAuth());
}
