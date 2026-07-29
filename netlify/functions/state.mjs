import { getStore } from "@netlify/blobs";

const STATE_KEY = "restaurant-esteban";
const MAX_BODY_BYTES = 1_000_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const validState = body =>
  body &&
  Number.isInteger(Number(body.baseRevision)) &&
  Array.isArray(body.devices) &&
  body.devices.length === 12 &&
  body.devices.every(device =>
    Number.isInteger(device.id) &&
    typeof device.name === "string" &&
    device.name.trim().length > 0 &&
    device.name.length <= 50
  ) &&
  body.monthLog &&
  typeof body.monthLog === "object" &&
  !Array.isArray(body.monthLog);

export default async request => {
  const expectedPin = Netlify.env.get("ESTEBAN_PIN");
  if (!expectedPin) return json({ error: "Server-PIN ist noch nicht eingerichtet." }, 503);
  if (request.headers.get("x-esteban-pin") !== expectedPin) {
    return json({ error: "PIN nicht korrekt." }, 401);
  }

  const store = getStore("esteban-temperature-state");
  const currentRecord = await store.getWithMetadata(STATE_KEY, { type: "json", consistency: "strong" });
  const current = currentRecord?.data || null;

  if (request.method === "GET") {
    return current ? json({ state: current }) : json({ error: "Noch keine zentralen Daten vorhanden." }, 404);
  }
  if (request.method !== "PUT") return json({ error: "Methode nicht unterstützt." }, 405);

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ error: "Datensatz ist zu groß." }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." }, 400);
  }
  if (!validState(body)) return json({ error: "Ungültige Temperaturdaten." }, 400);

  const currentRevision = Number(current?.revision) || 0;
  if (Number(body.baseRevision) !== currentRevision) {
    return json({ error: "Daten wurden inzwischen auf einem anderen Gerät geändert.", state: current }, 409);
  }

  const nextState = {
    revision: currentRevision + 1,
    updatedAt: new Date().toISOString(),
    devices: body.devices,
    monthLog: body.monthLog
  };
  const writeResult = await store.setJSON(
    STATE_KEY,
    nextState,
    currentRecord?.etag ? { onlyIfMatch: currentRecord.etag } : { onlyIfNew: true }
  );
  if (!writeResult.modified) {
    const latest = await store.get(STATE_KEY, { type: "json", consistency: "strong" });
    return json({ error: "Daten wurden gleichzeitig auf einem anderen Gerät geändert.", state: latest }, 409);
  }
  return json({ state: nextState });
};

export const config = {
  path: "/api/state"
};
