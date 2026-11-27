# Private family archive on Firebase

The app stays on GitHub Pages (https://filiphyza.github.io/family-time-box/). Photos, the family tree
and the computed face/scene data live in your own Firebase project. Only Google accounts on the
allowlist can read or change them. Everyone else sees a sign-in screen, and after signing in,
"This account does not have access".

| Piece | Where | Who can see it |
| --- | --- | --- |
| App code | GitHub (public) | Anyone (contains no photos and no secrets) |
| Photo records, family tree | Firestore `photos/*`, `archive/familyTree` | Allowlisted accounts (`firebase/firestore.rules`) |
| Image files | Cloud Storage `photos/<id>/…` | Allowlisted accounts (`firebase/storage.rules`) |
| Allowlist | Firestore `access/allowlist` → `emails` | Edited only in the console or by the upload script |
| Gemini key | Each person's browser (Settings > General) | Only that person |

Expected cost for this archive (about 0.7 GB of images, 21 MB of records, a few family members): **€0/month**,
within Firebase's free allowance. You need the Blaze (pay-as-you-go) plan, because new projects require it
for Cloud Storage. Set a budget alert.

## One-time setup (about 20 minutes)

1. **Create the project.** Go to https://console.firebase.google.com → *Add project* (Google Analytics is not needed).
   Upgrade to **Blaze**. In Google Cloud Billing → *Budgets & alerts*, create a €1 budget with email alerts.
2. **Firestore.** *Build → Firestore Database → Create database*, production mode, location `eur3` or `us-central1`.
3. **Storage.** *Build → Storage → Get started*, production mode. Pick **`us-central1`, `us-east1` or `us-west1`**:
   the no-cost 5 GB applies only there.
4. **Google sign-in.** *Build → Authentication → Get started → Sign-in method → Google → Enable*.
   Then go to *Authentication → Settings → Authorized domains → Add domain*: `filiphyza.github.io`.
5. **Web app config.** *Project settings → General → Your apps → Web (`</>`)*, register "Family Time Box"
   (Firebase Hosting is not needed). Copy the `firebaseConfig` object as JSON on one line, for example
   `{"apiKey":"…","authDomain":"….firebaseapp.com","projectId":"…","storageBucket":"….firebasestorage.app","messagingSenderId":"…","appId":"…"}`.
   On GitHub, go to *Repository → Settings → Secrets and variables → Actions → Variables → New repository variable*,
   name it `FIREBASE_CONFIG` and paste the JSON as its value. Or run:
   ```powershell
   & "C:\Program Files\GitHub CLI\gh.exe" variable set FIREBASE_CONFIG --repo filiphyza/family-time-box --body '<json>'
   ```
6. **Deploy the security rules** (from `E:\Photos\ancestrylens-app`):
   ```powershell
   npx firebase-tools login
   npx firebase-tools deploy --only firestore:rules,storage --project <projectId>
   ```
   Confirm when the CLI asks to let Storage rules read Firestore (the allowlist lives there).
7. **Upload the archive and set the allowlist.** In *Project settings → Service accounts → Generate new private key*,
   save the key **outside the repo** (for example `E:\keys\family-time-box-sa.json`). Run a dry run first, then the real upload:
   ```powershell
   node scripts/upload-archive-to-firebase.mjs --key E:\keys\family-time-box-sa.json --allow you@gmail.com,mom@gmail.com
   ```
   ```powershell
   node scripts/upload-archive-to-firebase.mjs --key E:\keys\family-time-box-sa.json --allow you@gmail.com,mom@gmail.com --apply
   ```
   The script also configures bucket CORS, so the site can load images for face and scene analysis.
   It is safe to re-run, but it overwrites photo records with the folder's values, so finish it before people start editing online.
8. **Redeploy the site.** Push to `main`, or re-run the *Deploy to GitHub Pages* workflow. The hosted app now opens in
   cloud mode and asks visitors to sign in.

## Day to day

- **Add or remove a family member:** in the Firebase console, open *Firestore → access → allowlist* and edit the `emails`
  array (lowercase addresses). You can also re-run the script with `--allow`, which only adds addresses.
- **AI restoration and captions:** each person pastes their own free key from https://aistudio.google.com/apikey into
  *Settings → General*.
- **Local development** still works with the folder or browser storage. To use the cloud archive locally, put
  `VITE_FIREBASE_CONFIG=<json>` in `.env.local` and sign in. `127.0.0.1` and `localhost` must be authorized domains;
  `localhost` is by default.

## Limits worth knowing

- Image links saved in the records are Firebase download URLs with an unguessable token. Only allowlisted people can
  read the records that contain them, but anyone who is given such a link can open that one image. This is standard for
  Firebase apps; don't paste image links publicly.
- Each app start reads every photo record (about 21 MB with the face and scene data). That is well within the free
  allowance for family use.
- The service-account key gives full control of the project. Keep it private and delete it in the console after the upload.
