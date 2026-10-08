import {clearAccountCaches} from './device-caches.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

// Firebase Authentication owns credentials; Firestore access is scoped by UID.

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

// For UI display: which account is signed in (email + short uid).
export function currentUserInfo() {
  const u = getAuth().currentUser;
  return u ? { uid: u.uid, email: u.email } : null;
}

export async function login(email, password) {
  await signInWithEmailAndPassword(getAuth(), email.trim(), password);
}

export async function register(email, password) {
  await createUserWithEmailAndPassword(getAuth(), email.trim(), password);
}

export async function resetPassword(email) {
  await sendPasswordResetEmail(getAuth(), email.trim());
}

export async function changePassword(currentPassword, newPassword) {
  const user = getAuth().currentUser;
  if (!user?.email) throw new Error("Please sign in again to change your password.");
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, newPassword);
}

export async function logout() {
  await clearAccountCaches(currentUid());
  await signOut(getAuth());
}
