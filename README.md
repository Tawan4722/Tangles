# Tangles (Local Password Manager)

Tangles is a local-first password manager that runs as a portable Windows app.

- First launch: create a PIN and receive a recovery code.
- Next launches: unlock with PIN only.
- Data is stored locally in an encrypted vault file (`.tangles`), not on a remote server.

## Quick Start (One Click)

From the `release` folder:

1. Double-click `Open-Tangles.cmd`
2. It starts `tangles-local-win.exe`
3. It opens the app in your browser on `http://127.0.0.1:<port>`

If needed, you can run `tangles-local-win.exe` directly.

## First-Time Setup

1. Open app
2. Create PIN (4-12 digits)
3. Save the recovery code shown on screen

You need this recovery code to reset PIN if forgotten.

## Daily Use

1. Unlock with PIN
2. Add entries (`Name`, `Password`)
3. Use search to find entries
4. Use `Copy` or `Reveal` per entry
5. Click `Lock` when done

## Portability

You can move the app to another drive/USB.

Keep these together:

- `tangles-local-win.exe`
- your vault file (default: `vault.tangles`)
- `Open-Tangles.cmd` (optional launcher)

## Security Notes

- Vault data is encrypted locally (`AES-256-GCM`).
- PIN/recovery unlock access to the vault key.
- Nothing is uploaded by default.

## Repo Safety

Sensitive files are excluded from git:

- `*.tangles` (vaults)
- logs/temp files (`*.log`, `*.out`, `*.err`, `*.tmp`)

Only safe release artifacts are tracked in `release/`:

- `release/tangles-local-win.exe`
- `release/Open-Tangles.cmd`

## Source Layout

- `tangles-local/server.cjs` - local API + encryption + session flow
- `tangles-local/static/index.html` - UI structure
- `tangles-local/static/styles.css` - UI styling
- `tangles-local/static/app.js` - client logic

