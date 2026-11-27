import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User,
} from 'firebase/auth';
import type { FirebaseConfig } from '../types';

/**
 * Firebase web config baked in at build time (GitHub repository variable FIREBASE_CONFIG,
 * passed to the build as VITE_FIREBASE_CONFIG). These values identify the project; they are
 * not secrets. Access to the archive is enforced by firestore.rules and storage.rules.
 */
export const hostedFirebaseConfig: FirebaseConfig | null = (() => {
  const raw = (import.meta.env.VITE_FIREBASE_CONFIG || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.apiKey && parsed?.projectId ? parsed as FirebaseConfig : null;
  } catch {
    console.error('VITE_FIREBASE_CONFIG is not valid JSON; cloud storage is not preconfigured.');
    return null;
  }
})();

export const firebaseAppFor = (config: FirebaseConfig): FirebaseApp => {
  // Avoid initializing twice in dev hot-reload. A changed config replaces nothing until reload.
  return getApps().length === 0 ? initializeApp(config) : getApp();
};

/** Resolves once Firebase has restored any persisted session (null when signed out). */
export const currentFirebaseUser = (config: FirebaseConfig): Promise<User | null> => {
  const auth = getAuth(firebaseAppFor(config));
  return new Promise(resolve => {
    const stop = onAuthStateChanged(auth, user => { stop(); resolve(user); });
  });
};

export const signInWithGoogle = async (config: FirebaseConfig): Promise<User> => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return (await signInWithPopup(getAuth(firebaseAppFor(config)), provider)).user;
};

export const signOutOfFirebase = async (config: FirebaseConfig): Promise<void> => {
  await signOut(getAuth(firebaseAppFor(config)));
};

export const isPermissionDenied = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code || '';
  return code === 'permission-denied' || code === 'storage/unauthorized' || code === 'firestore/permission-denied';
};
