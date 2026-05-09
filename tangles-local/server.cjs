const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");
const express = require("express");
const { v4: uuidv4 } = require("uuid");

const DEFAULT_PORT = 8787;
const IDLE_SESSION_MS = 10 * 60 * 1000;
const ABSOLUTE_SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_FAILED_UNLOCKS = 5;
const LOCKOUT_MS = 30 * 1000;
const app = express();
const sessions = new Map();
const unlockFailures = new Map();

app.disable("x-powered-by");
app.set("etag", false);

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "static")));

const MAGIC = "TANGLES1";
const VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function randomBytes(n) {
  return crypto.randomBytes(n);
}

function b64u(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64u(v) {
  return Buffer.from(v, "base64url");
}

function deriveKey(input, salt, keylen = 32) {
  return crypto.scryptSync(input, salt, keylen, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  });
}

function encryptBlob(key, plaintextBuf) {
  const iv = randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64u(iv), ciphertext: b64u(ciphertext), tag: b64u(tag) };
}

function decryptBlob(key, blob) {
  const iv = fromB64u(blob.iv);
  const ciphertext = fromB64u(blob.ciphertext);
  const tag = fromB64u(blob.tag);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function resolveVaultPath(rawPath) {
  const value = (rawPath || "").trim();
  if (!value) return path.join(process.cwd(), "vault.tangles");
  if (path.isAbsolute(value)) return value;
  return path.resolve(process.cwd(), value);
}

function readVault(vaultPath) {
  return JSON.parse(fs.readFileSync(vaultPath, "utf8"));
}

function writeVaultAtomic(vaultPath, obj) {
  const dir = path.dirname(vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${vaultPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(obj), "utf8");
  fs.renameSync(tmpPath, vaultPath);
}

function generateRecoveryCode() {
  const raw = randomBytes(20).toString("base64url").toUpperCase();
  return raw.replace(/[^A-Z0-9]/g, "").slice(0, 30).match(/.{1,5}/g).join("-");
}

function validatePin(pin) {
  if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) {
    throw new Error("pin must be 4-12 digits");
  }
}

function createVault(rawVaultPath, pin) {
  validatePin(pin);
  const vaultPath = resolveVaultPath(rawVaultPath);
  if (fs.existsSync(vaultPath)) throw new Error("vault file already exists");

  const recoveryCode = generateRecoveryCode();
  const pinSalt = randomBytes(16);
  const recoverySalt = randomBytes(16);
  const dek = randomBytes(32);
  const pinKey = deriveKey(Buffer.from(pin, "utf8"), pinSalt);
  const recoveryKeyWrap = deriveKey(Buffer.from(recoveryCode, "utf8"), recoverySalt);

  const vaultData = { entries: [] };
  const stored = {
    header: { magic: MAGIC, version: VERSION, kdf: { name: "scrypt", n: 32768, r: 8, p: 1 } },
    pin_salt: b64u(pinSalt),
    recovery_salt: b64u(recoverySalt),
    pin_encrypted_dek: encryptBlob(pinKey, dek),
    recovery_encrypted_dek: encryptBlob(recoveryKeyWrap, dek),
    vault_data: encryptBlob(dek, Buffer.from(JSON.stringify(vaultData), "utf8"))
  };

  writeVaultAtomic(vaultPath, stored);
  return { recoveryCode, vaultPath };
}

function readAndValidate(vaultPath) {
  const stored = readVault(vaultPath);
  if (stored?.header?.magic !== MAGIC || stored?.header?.version !== VERSION) {
    throw new Error("invalid vault file");
  }
  return stored;
}

function pinSaltFromVault(stored) {
  return stored.pin_salt || stored.password_salt;
}

function pinWrapFromVault(stored) {
  return stored.pin_encrypted_dek || stored.password_encrypted_dek;
}

function unlockByPin(rawVaultPath, pin) {
  validatePin(pin);
  const vaultPath = resolveVaultPath(rawVaultPath);
  const stored = readAndValidate(vaultPath);
  const pinSalt = pinSaltFromVault(stored);
  const pinWrap = pinWrapFromVault(stored);
  if (!pinSalt || !pinWrap) throw new Error("vault is missing pin credentials");
  const pinKey = deriveKey(Buffer.from(pin, "utf8"), fromB64u(pinSalt));
  const dek = decryptBlob(pinKey, pinWrap);
  const data = JSON.parse(decryptBlob(dek, stored.vault_data).toString("utf8"));
  return { vaultPath, stored, dek, data };
}

function resetPinWithRecovery(rawVaultPath, recoveryKeyText, newPin) {
  validatePin(newPin);
  const recoveryCode = (recoveryKeyText || "").trim().toUpperCase();
  const vaultPath = resolveVaultPath(rawVaultPath);
  const stored = readAndValidate(vaultPath);

  const recoveryKey = deriveKey(Buffer.from(recoveryCode, "utf8"), fromB64u(stored.recovery_salt));
  const dek = decryptBlob(recoveryKey, stored.recovery_encrypted_dek);
  const data = JSON.parse(decryptBlob(dek, stored.vault_data).toString("utf8"));

  const pinSalt = randomBytes(16);
  const pinKey = deriveKey(Buffer.from(newPin, "utf8"), pinSalt);
  stored.pin_salt = b64u(pinSalt);
  stored.pin_encrypted_dek = encryptBlob(pinKey, dek);

  delete stored.password_salt;
  delete stored.password_encrypted_dek;

  writeVaultAtomic(vaultPath, stored);
  return { vaultPath, stored, dek, data };
}

function saveSessionVault(session) {
  session.stored.vault_data = encryptBlob(session.dek, Buffer.from(JSON.stringify(session.data), "utf8"));
  writeVaultAtomic(session.vaultPath, session.stored);
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) throw new Error("invalid session");
  const now = Date.now();
  if (now - s.lastSeenAt > IDLE_SESSION_MS || now - s.createdAt > ABSOLUTE_SESSION_MS) {
    sessions.delete(token);
    throw new Error("session expired");
  }
  s.lastSeenAt = now;
  return s;
}

function getSessionToken(req) {
  return req.get("X-Session-Token") || req.query.session_token || req.body.session_token;
}

function createSession(session) {
  const sessionToken = uuidv4();
  sessions.set(sessionToken, {
    ...session,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  });
  return sessionToken;
}

function lockoutKey(rawVaultPath) {
  return resolveVaultPath(rawVaultPath).toLowerCase();
}

function checkUnlockAllowed(rawVaultPath) {
  const state = unlockFailures.get(lockoutKey(rawVaultPath));
  if (state?.lockUntil && state.lockUntil > Date.now()) {
    const seconds = Math.ceil((state.lockUntil - Date.now()) / 1000);
    throw new Error(`too many failed attempts; wait ${seconds}s`);
  }
}

function recordUnlockSuccess(rawVaultPath) {
  unlockFailures.delete(lockoutKey(rawVaultPath));
}

function recordUnlockFailure(rawVaultPath) {
  const key = lockoutKey(rawVaultPath);
  const state = unlockFailures.get(key) || { count: 0, lockUntil: 0 };
  state.count += 1;
  state.lockUntil = state.count >= MAX_FAILED_UNLOCKS ? Date.now() + LOCKOUT_MS : 0;
  unlockFailures.set(key, state);
}

app.get("/api/state", (req, res) => {
  try {
    const vaultPath = resolveVaultPath(req.query.vault_path);
    res.json({
      vault_path: vaultPath,
      exists: fs.existsSync(vaultPath)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/create", (req, res) => {
  try {
    const { recoveryCode, vaultPath } = createVault(req.body.vault_path, req.body.pin);
    res.json({ recovery_code: recoveryCode, vault_path: vaultPath });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/unlock", (req, res) => {
  try {
    checkUnlockAllowed(req.body.vault_path);
    const session = unlockByPin(req.body.vault_path, req.body.pin);
    recordUnlockSuccess(req.body.vault_path);
    const sessionToken = createSession(session);
    res.json({ session_token: sessionToken });
  } catch (e) {
    if (!e.message.startsWith("too many failed attempts")) {
      recordUnlockFailure(req.body.vault_path);
    }
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/recover-reset-pin", (req, res) => {
  try {
    checkUnlockAllowed(req.body.vault_path);
    const session = resetPinWithRecovery(req.body.vault_path, req.body.recovery_key, req.body.new_pin);
    recordUnlockSuccess(req.body.vault_path);
    const sessionToken = createSession(session);
    res.json({ session_token: sessionToken });
  } catch (e) {
    if (!e.message.startsWith("too many failed attempts")) {
      recordUnlockFailure(req.body.vault_path);
    }
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/lock", (req, res) => {
  sessions.delete(req.body.session_token);
  res.status(204).end();
});

app.get("/api/entries", (req, res) => {
  try {
    const s = getSession(getSessionToken(req));
    const entries = s.data.entries
      .map((e) => ({
        id: e.id,
        name: e.name || e.title || "",
        updated_at: e.updated_at || e.created_at || ""
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(entries);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get("/api/entries/:id/password", (req, res) => {
  try {
    const s = getSession(getSessionToken(req));
    const item = s.data.entries.find((x) => x.id === req.params.id);
    if (!item) throw new Error("entry not found");
    res.json({ password: item.password || "" });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/entries", (req, res) => {
  try {
    const s = getSession(getSessionToken(req));
    const name = (req.body.name || "").trim();
    const password = req.body.password || "";
    if (!name) throw new Error("name is required");
    if (!password) throw new Error("password is required");

    const id = uuidv4();
    const now = nowIso();
    s.data.entries.push({
      id,
      name,
      password,
      created_at: now,
      updated_at: now
    });
    saveSessionVault(s);
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/entries", (req, res) => {
  try {
    const s = getSession(getSessionToken(req));
    const item = s.data.entries.find((x) => x.id === req.body.id);
    if (!item) throw new Error("entry not found");

    const nextName = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const nextPassword = typeof req.body.password === "string" ? req.body.password : "";
    if (!nextName) throw new Error("name is required");
    if (!nextPassword) throw new Error("password is required");

    item.name = nextName;
    item.password = nextPassword;
    item.updated_at = nowIso();
    saveSessionVault(s);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/entries/:id", (req, res) => {
  try {
    const s = getSession(getSessionToken(req));
    const before = s.data.entries.length;
    s.data.entries = s.data.entries.filter((x) => x.id !== req.params.id);
    if (s.data.entries.length === before) throw new Error("entry not found");
    saveSessionVault(s);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/save", (req, res) => {
  try {
    const s = getSession(getSessionToken(req));
    saveSessionVault(s);
    res.status(204).end();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function openBrowser(url) {
  if (process.argv.includes("--no-open")) return;
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function startServer(port) {
  const server = app.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`Tangles local web running at ${url}`);
    openBrowser(url);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE" && port < DEFAULT_PORT + 20) {
      startServer(port + 1);
      return;
    }
    console.error("Failed to start Tangles:", err.message || err);
    process.exit(1);
  });
}

startServer(DEFAULT_PORT);
