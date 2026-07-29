(() => {
  const endpoint = "/api/state";
  const originalPersist = persist;
  const syncElement = document.querySelector("#syncState");
  const pinBackdrop = document.querySelector("#pinBackdrop");
  const pinInput = document.querySelector("#pinInput");
  const pinNote = document.querySelector("#pinNote");
  let pin = sessionStorage.getItem("esteban-sync-pin") || "";
  let revision = 0;
  let syncedSnapshot = null;
  let syncTimer = null;
  let syncInFlight = false;
  let syncQueued = false;

  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const localSnapshot = () => ({ devices: clone(devices), monthLog: clone(monthLog) });

  function setSyncState(text, state = "") {
    syncElement.textContent = text;
    syncElement.className = `sync-state ${state}`.trim();
  }

  function showPin(message = "Die PIN wird nur für diese Browsersitzung gespeichert.") {
    pinNote.textContent = message;
    pinBackdrop.classList.add("open");
    requestAnimationFrame(() => pinInput.focus());
  }

  function applyRemote(state) {
    if (!state || !Array.isArray(state.devices) || typeof state.monthLog !== "object") return false;
    devices = clone(state.devices);
    monthLog = clone(state.monthLog);
    revision = Number(state.revision) || 0;
    syncedSnapshot = localSnapshot();
    originalPersist();
    renderDeviceSelect();
    render();
    renderMonth();
    renderArchive();
    updateEmailLink();
    return true;
  }

  function mergeLocalChanges(base, local, remote) {
    const merged = {
      devices: clone(remote.devices),
      monthLog: clone(remote.monthLog || {})
    };
    const baseDevices = new Map((base?.devices || []).map(device => [device.id, device]));
    const mergedDevices = new Map(merged.devices.map(device => [device.id, device]));
    local.devices.forEach(localDevice => {
      const target = mergedDevices.get(localDevice.id);
      if (!target) return;
      const baseDevice = baseDevices.get(localDevice.id) || {};
      Object.keys(localDevice).forEach(key => {
        if (!equal(localDevice[key], baseDevice[key])) target[key] = clone(localDevice[key]);
      });
    });
    Object.entries(local.monthLog || {}).forEach(([date, entries]) => {
      Object.entries(entries || {}).forEach(([deviceId, entry]) => {
        const baseEntry = base?.monthLog?.[date]?.[deviceId];
        if (!equal(entry, baseEntry)) {
          merged.monthLog[date] ||= {};
          merged.monthLog[date][deviceId] = clone(entry);
        }
      });
    });
    return merged;
  }

  async function request(method, body) {
    const response = await fetch(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Esteban-Pin": pin
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    return { response, payload };
  }

  async function loadRemote({ initial = false } = {}) {
    if (!pin || syncInFlight) return;
    setSyncState("Daten werden aktualisiert …", "busy");
    try {
      const { response, payload } = await request("GET");
      if (response.status === 401) {
        sessionStorage.removeItem("esteban-sync-pin");
        pin = "";
        setSyncState("PIN erforderlich", "offline");
        showPin("Die PIN war nicht korrekt. Bitte erneut eingeben.");
        return;
      }
      if (response.status === 404 && initial) {
        revision = 0;
        syncedSnapshot = { devices: clone(defaults), monthLog: {} };
        queueSync(true);
        return;
      }
      if (!response.ok) throw new Error(`Abruf fehlgeschlagen (${response.status})`);
      if (payload?.state && Number(payload.state.revision) > revision) applyRemote(payload.state);
      setSyncState("Auf allen Geräten gespeichert", "online");
    } catch (error) {
      console.warn("Synchronisierung vorübergehend nicht verfügbar:", error);
      setSyncState("Offline – lokal zwischengespeichert", "offline");
    }
  }

  async function saveRemote(snapshot, attempt = 0) {
    const { response, payload } = await request("PUT", {
      baseRevision: revision,
      devices: snapshot.devices,
      monthLog: snapshot.monthLog
    });
    if (response.status === 401) {
      sessionStorage.removeItem("esteban-sync-pin");
      pin = "";
      showPin("Die PIN war nicht korrekt. Bitte erneut eingeben.");
      throw new Error("PIN erforderlich");
    }
    if (response.status === 409 && payload?.state && attempt < 2) {
      const merged = mergeLocalChanges(syncedSnapshot, snapshot, payload.state);
      revision = Number(payload.state.revision) || revision;
      devices = clone(merged.devices);
      monthLog = clone(merged.monthLog);
      originalPersist();
      renderDeviceSelect();
      render();
      renderMonth();
      renderArchive();
      return saveRemote(merged, attempt + 1);
    }
    if (!response.ok) throw new Error(payload?.error || `Speichern fehlgeschlagen (${response.status})`);
    revision = Number(payload.state?.revision) || revision + 1;
    syncedSnapshot = clone(snapshot);
  }

  async function flushSync() {
    if (!pin) {
      setSyncState("Nur lokal gespeichert – PIN fehlt", "offline");
      return;
    }
    if (syncInFlight) {
      syncQueued = true;
      return;
    }
    syncInFlight = true;
    syncQueued = false;
    setSyncState("Wird auf allen Geräten gespeichert …", "busy");
    try {
      await saveRemote(localSnapshot());
      setSyncState("Auf allen Geräten gespeichert", "online");
    } catch (error) {
      console.warn("Synchronisierung vorübergehend nicht verfügbar:", error);
      setSyncState("Offline – lokal zwischengespeichert", "offline");
    } finally {
      syncInFlight = false;
      if (syncQueued) queueSync(true);
    }
  }

  function queueSync(immediate = false) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, immediate ? 0 : 300);
  }

  persist = function () {
    originalPersist();
    queueSync();
  };

  document.querySelector("#pinForm").addEventListener("submit", async event => {
    event.preventDefault();
    pin = pinInput.value.trim();
    if (!pin) return;
    sessionStorage.setItem("esteban-sync-pin", pin);
    pinBackdrop.classList.remove("open");
    await loadRemote({ initial: true });
  });
  document.querySelector("#pinClose").addEventListener("click", () => pinBackdrop.classList.remove("open"));
  document.querySelector("#pinOffline").addEventListener("click", () => {
    pinBackdrop.classList.remove("open");
    setSyncState("Nur auf diesem Gerät gespeichert", "offline");
  });
  pinBackdrop.addEventListener("click", event => {
    if (event.target === pinBackdrop) pinBackdrop.classList.remove("open");
  });

  window.addEventListener("focus", () => loadRemote());
  window.addEventListener("online", () => loadRemote());
  setInterval(() => loadRemote(), 20000);

  if (pin) loadRemote({ initial: true });
  else {
    setSyncState("PIN erforderlich", "offline");
    showPin();
  }
})();
