# ELCSA Mavhola Parish Mobile App Release Readiness

## App identifiers
- App name: ELCSA Mavhola Parish
- Android application ID / iOS bundle ID: `za.co.mavholaparish.app`
- Website: https://mavholaparish.co.za
- App icon source: `public/elcsa-logo.png`
- Primary parish contact: mavholaparish.yl@gmail.com

## Build pipeline
- Android CI creates a debug APK and release APK/AAB build artifacts.
- iOS CI creates a simulator app artifact to validate the iOS project and compile.
- Both pipelines regenerate parish-branded app icons from the official logo.

## Before Google Play release
1. Create/confirm Google Play Console developer account.
2. Confirm the permanent app identifier, store name, screenshots, description, category, and contact information.
3. Add a public Privacy Policy URL and complete Play Console Data Safety disclosures.
4. Generate and securely retain the Android release signing key. Never commit it.
5. Configure GitHub Actions secrets for release signing only after the key has been safely backed up.
6. Build a signed Android App Bundle (AAB), test on real devices, and complete required Play testing/review.

## Before Apple App Store release
1. Enroll/confirm Apple Developer Program account and team.
2. Complete a public Privacy Policy and App Store Connect privacy disclosures.
3. Add App Store listing metadata, screenshots, support URL, and review contact details.
4. Configure signing certificates and provisioning profiles in a secure build environment.
5. Build a signed archive/IPA and test through TestFlight.
6. Ensure the app provides meaningful app-specific functionality and mobile experience beyond simply repackaging the parish website. App Review may reject a website-only wrapper under minimum-functionality rules.

## Current limitations / status
- Native sharing has been added to the public site/app experience (native share sheet where supported; browser fallback).
- The app shell currently opens the parish website over HTTPS. It is not yet a fully offline native app.
- The Android release artifacts produced by CI are unsigned and cannot be uploaded directly to Play as a final release.
- The iOS CI build is a simulator build only; it is not a signed App Store IPA.
- Store submission and approval are not complete.

## Legal and operational review
The parish should review and approve its Privacy Policy, retention practices, and public contact details before store submission. This checklist is technical preparation and is not legal advice.
