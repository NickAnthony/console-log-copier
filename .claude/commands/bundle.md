# /bundle - Bundle Chrome Extension

Bundle the chrome extension into a zip file tagged with the current git commit SHA.

## Steps

1. Get the short git commit SHA from HEAD: `git rev-parse --short HEAD`
2. Read `chrome-extension/manifest.json` and temporarily set the `version_name` field to `"{version}-{sha}"` (e.g. `"1.0.0-aefb054"`). If `version_name` already exists, replace it. Do NOT change the `version` field.
3. Create the zip: `cd chrome-extension && zip -r ../chrome-extension-{sha}.zip . -x "*.DS_Store"`
4. Restore `manifest.json` back to its original state (remove or revert the `version_name` change) so the working tree stays clean.
5. Print the output zip path and the full commit SHA for reference.
