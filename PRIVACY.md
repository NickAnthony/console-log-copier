# Privacy Policy

**Console Log Copier** is a browser extension that captures console log output for local viewing and copying.

## Data Collection

This extension does **not** collect, store, transmit, or share any personal data or browsing activity.

## How It Works

- Console logs are captured from the active tab and stored temporarily in local browser storage.
- Logs are only accessible through the extension popup and are never sent to any external server or third party.
- Logs are cleared when the tab is closed or when the user manually clears them.

## Permissions

The extension requests the following permissions, used solely for its core functionality:

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab to capture console output |
| `scripting` | Inject the console interceptor into the page |
| `storage` | Store captured logs locally per tab |
| `clipboardWrite` | Copy logs to the clipboard when requested by the user |

## Third-Party Services

This extension does not use any third-party services, analytics, or tracking.

## Contact

If you have questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/NickAnthony/console-log-copier).
