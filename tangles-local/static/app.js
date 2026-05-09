let sessionToken = "";
let cache = [];
let editingId = "";
const revealed = new Set();

const STORAGE_KEY = "tangles_last_vault_path";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const entriesEl = $("entries");
const vaultPanelEl = $("vaultPanel");
const recoveryOutEl = $("recoveryOut");
const entryDialogEl = $("entryDialog");
const entryFormEl = $("entryForm");

function setStatus(message) {
  statusEl.textContent = message || "";
}

function vaultPath() {
  return $("vaultPath").value.trim();
}

function isPinPairValid(pin, confirmPin) {
  if (!/^\d{4,12}$/.test(pin)) return "PIN must be 4-12 digits";
  if (pin !== confirmPin) return "PIN and confirm PIN do not match";
  return "";
}

function closeDialog() {
  entryDialogEl.close();
  editingId = "";
  $("entryName").value = "";
  $("entryPassword").value = "";
}

function openAddDialog() {
  editingId = "";
  $("dialogTitle").textContent = "Add Entry";
  $("saveEntryBtn").textContent = "Save";
  $("deleteEntryBtn").classList.add("hidden");
  $("entryName").value = "";
  $("entryPassword").value = "";
  entryDialogEl.showModal();
}

function openEditDialog(entry) {
  editingId = entry.id;
  $("dialogTitle").textContent = "Edit Entry";
  $("saveEntryBtn").textContent = "Update";
  $("deleteEntryBtn").classList.remove("hidden");
  $("entryName").value = entry.name;
  $("entryPassword").value = entry.password;
  entryDialogEl.showModal();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "request failed");
  return data;
}

function filteredEntries() {
  const q = ($("search").value || "").trim().toLowerCase();
  if (!q) return cache;
  return cache.filter((e) => (e.name || "").toLowerCase().includes(q));
}

function maskedPassword(value) {
  return "*".repeat(Math.max(8, Math.min(value.length, 22)));
}

async function copyPassword(text) {
  await navigator.clipboard.writeText(text);
  setStatus("Password copied to clipboard");
}

function renderEntries(items) {
  entriesEl.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "entry-item";
    li.textContent = "No passwords yet";
    entriesEl.appendChild(li);
    return;
  }

  items.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "entry-item";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "entry-name";
    name.textContent = entry.name;
    name.title = entry.name;
    name.onclick = () => openEditDialog(entry);

    const pw = document.createElement("div");
    pw.className = "entry-password";
    pw.textContent = revealed.has(entry.id) ? entry.password : maskedPassword(entry.password);

    left.appendChild(name);
    left.appendChild(pw);

    const actions = document.createElement("div");
    actions.className = "entry-actions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "blur-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = async () => {
      try {
        await copyPassword(entry.password);
      } catch (e) {
        setStatus(e.message);
      }
    };

    const revealBtn = document.createElement("button");
    revealBtn.className = "blur-btn";
    revealBtn.type = "button";
    revealBtn.textContent = revealed.has(entry.id) ? "Hide" : "Reveal";
    revealBtn.onclick = () => {
      if (revealed.has(entry.id)) revealed.delete(entry.id);
      else revealed.add(entry.id);
      renderEntries(filteredEntries());
    };

    actions.appendChild(copyBtn);
    actions.appendChild(revealBtn);

    li.appendChild(left);
    li.appendChild(actions);
    entriesEl.appendChild(li);
  });
}

async function refresh() {
  const items = await api(`/api/entries?session_token=${encodeURIComponent(sessionToken)}`);
  cache = items;
  renderEntries(filteredEntries());
}

function setUnlocked(unlocked) {
  vaultPanelEl.classList.toggle("hidden", !unlocked);
  if (!unlocked) {
    cache = [];
    revealed.clear();
    renderEntries([]);
  }
}

$("createBtn").onclick = async () => {
  try {
    const pin = $("createPin").value.trim();
    const confirm = $("createPinConfirm").value.trim();
    const error = isPinPairValid(pin, confirm);
    if (error) throw new Error(error);

    localStorage.setItem(STORAGE_KEY, vaultPath());
    const data = await api("/api/create", {
      method: "POST",
      body: JSON.stringify({
        vault_path: vaultPath(),
        pin
      })
    });

    recoveryOutEl.classList.remove("hidden");
    recoveryOutEl.textContent = `Recovery code (save this now): ${data.recovery_code}`;
    setStatus(`Vault created at ${data.vault_path}. Unlock with PIN.`);
  } catch (e) {
    setStatus(e.message);
  }
};

$("unlockBtn").onclick = async () => {
  try {
    localStorage.setItem(STORAGE_KEY, vaultPath());
    const data = await api("/api/unlock", {
      method: "POST",
      body: JSON.stringify({
        vault_path: vaultPath(),
        pin: $("unlockPin").value.trim()
      })
    });
    sessionToken = data.session_token;
    await refresh();
    setUnlocked(true);
    setStatus("Unlocked");
  } catch (e) {
    setStatus(e.message);
  }
};

$("recoverBtn").onclick = async () => {
  try {
    localStorage.setItem(STORAGE_KEY, vaultPath());
    const newPin = $("newPin").value.trim();
    if (!/^\d{4,12}$/.test(newPin)) throw new Error("New PIN must be 4-12 digits");

    const data = await api("/api/recover-reset-pin", {
      method: "POST",
      body: JSON.stringify({
        vault_path: vaultPath(),
        recovery_key: $("recoveryCode").value.trim(),
        new_pin: newPin
      })
    });
    sessionToken = data.session_token;
    await refresh();
    setUnlocked(true);
    setStatus("PIN reset completed and vault unlocked");
  } catch (e) {
    setStatus(e.message);
  }
};

$("lockBtn").onclick = async () => {
  try {
    await api("/api/lock", {
      method: "POST",
      body: JSON.stringify({ session_token: sessionToken })
    });
    sessionToken = "";
    setUnlocked(false);
    setStatus("Locked");
  } catch (e) {
    setStatus(e.message);
  }
};

$("addBtn").onclick = () => openAddDialog();
$("cancelEntryBtn").onclick = () => closeDialog();

entryFormEl.onsubmit = async (event) => {
  event.preventDefault();
  try {
    const name = $("entryName").value.trim();
    const password = $("entryPassword").value;
    if (!name) throw new Error("Name is required");
    if (!password) throw new Error("Password is required");

    if (!editingId) {
      await api("/api/entries", {
        method: "POST",
        body: JSON.stringify({
          session_token: sessionToken,
          name,
          password
        })
      });
      setStatus("Entry added");
    } else {
      await api("/api/entries", {
        method: "PUT",
        body: JSON.stringify({
          session_token: sessionToken,
          id: editingId,
          name,
          password
        })
      });
      setStatus("Entry updated");
    }
    closeDialog();
    await refresh();
  } catch (e) {
    setStatus(e.message);
  }
};

$("deleteEntryBtn").onclick = async () => {
  try {
    if (!editingId) return;
    await api(`/api/entries/${encodeURIComponent(editingId)}?session_token=${encodeURIComponent(sessionToken)}`, {
      method: "DELETE"
    });
    closeDialog();
    await refresh();
    setStatus("Entry deleted");
  } catch (e) {
    setStatus(e.message);
  }
};

$("search").oninput = () => renderEntries(filteredEntries());

(() => {
  const lastPath = localStorage.getItem(STORAGE_KEY);
  if (lastPath) $("vaultPath").value = lastPath;
  setUnlocked(false);
})();
