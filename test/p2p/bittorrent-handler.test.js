import { expect } from "chai";
import sinon from "sinon";
import esmock from "esmock";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

const HASH_HEX = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const MAGNET = `magnet:?xt=urn:btih:${HASH_HEX}&dn=Test`;

function btihFromMagnet(s) {
  const m = String(s).match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : HASH_HEX;
}

// Pretends to be the forked worker: emits `ready`, then answers send({ id, action, ... })
// the same way src/protocols/bt/worker.js does for sendCommand().
function makeFakeChild(onCommand) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let firedReady = false;
  const _on = child.on.bind(child);
  child.on = function (ev, fn) {
    const r = _on(ev, fn);
    if (ev === "message" && !firedReady) {
      firedReady = true;
      queueMicrotask(() => child.emit("message", { type: "ready" }));
    }
    return r;
  };
  const run = onCommand(child);
  child.send = sinon.spy((msg) => queueMicrotask(() => run(msg)));
  return child;
}

function defaultWorkerReplies(proc) {
  return (msg) => {
    const { id, action } = msg;
    if (!id) return;
    if (action === "start") {
      const ih = btihFromMagnet(msg.magnetUri);
      proc.emit("message", { id, type: "started", infoHash: ih, magnetURI: msg.magnetUri });
      return;
    }
    if (action === "seed") {
      const ih = btihFromMagnet(msg.magnetUri);
      proc.emit("message", {
        id,
        type: "started",
        infoHash: ih,
        magnetURI: msg.magnetUri,
        mode: "seed",
      });
      return;
    }
    if (action === "pause") {
      proc.emit("message", { id, type: "paused", infoHash: msg.hash || HASH_HEX });
      return;
    }
    if (action === "resume") {
      proc.emit("message", { id, type: "resumed", infoHash: msg.hash || HASH_HEX });
      return;
    }
    if (action === "remove") {
      proc.emit("message", { id, type: "removed", infoHash: msg.hash || HASH_HEX });
      return;
    }
    proc.emit("message", { id, error: `Unknown action: ${action}` });
  };
}

async function jsonBody(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function apiToken(html) {
  const m = String(html).match(/var apiToken = "([a-f0-9]+)"/);
  return m ? m[1] : null;
}

function apiQuery(parts) {
  return `bt://api?${new URLSearchParams({ action: "api", ...parts }).toString()}`;
}

describe("BitTorrent protocol handler", function () {
  this.timeout(20000);

  afterEach(() => sinon.restore());

  async function loadHandler(opts = {}) {
    const { userDataDir, downloadsDir, replyAs } = opts;
    const ud = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-ud-"));
    const dd = downloadsDir || fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-dl-"));
    const fork = sinon.stub();

    // strict so ../settings-manager.js is not merged with the real module (pulls permissions → electron).
    const mod = await esmock.strict("../../src/protocols/bittorrent-handler.js", {
      child_process: { fork },
      electron: {
        app: {
          getPath(t) {
            if (t === "userData") return ud;
            if (t === "downloads") return dd;
            return path.join(ud, t);
          },
        },
        ipcMain: { handle: sinon.stub() },
      },
      "../../src/logger.js": {
        createLogger: () => ({ info() {}, warn() {}, error() {} }),
      },
      "../../src/settings-manager.js": {
        default: { settings: { theme: "dark" } },
      },
    });

    const child = makeFakeChild((proc) => (replyAs ? replyAs(proc) : defaultWorkerReplies(proc)));
    fork.returns(child);

    const handler = await mod.createHandler();
    return { handler, child, ud, dd };
  }

  it("serves torrent UI on bt:// and puts apiToken in the page", async () => {
    const { handler } = await loadHandler();
    const res = await handler(new Request(`bt://${HASH_HEX}/`));
    expect(res.status).to.equal(200);
    expect(res.headers.get("Content-Type")).to.match(/text\/html/);
    const html = await res.text();
    expect(html).to.include("BitTorrent");
    expect(apiToken(html)).to.have.lengthOf(48);
  });

  it("serves torrent UI for magnet: URLs", async () => {
    const { handler } = await loadHandler();
    const res = await handler(new Request(MAGNET));
    expect(res.status).to.equal(200);
    expect(apiToken(await res.text())).to.be.a("string");
  });

  it("rejects API calls when request.url is not bt/bittorrent/magnet", async () => {
    const { handler, child } = await loadHandler();
    const n = child.send.callCount;
    const res = await handler(
      new Request(`https://evil.example/x?action=api&api=status&hash=${HASH_HEX}`),
    );
    expect(res.status).to.equal(403);
    expect((await jsonBody(res)).error).to.equal("Forbidden: API only accessible from BitTorrent protocol");
    expect(child.send.callCount).to.equal(n);
  });

  it("mutations without POST get 405 and no CORS wildcard", async () => {
    const { handler, child } = await loadHandler();
    const n = child.send.callCount;
    const url = apiQuery({ api: "start", magnet: encodeURIComponent(MAGNET) });
    const res = await handler(new Request(url, { method: "GET" }));
    expect(res.status).to.equal(405);
    expect(res.headers.get("Access-Control-Allow-Origin")).to.equal(null);
    expect(child.send.callCount).to.equal(n);
  });

  it("mutations need a valid token; pause works with token from the UI page", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    expect(token).to.be.a("string");

    const start = apiQuery({ api: "start", magnet: encodeURIComponent(MAGNET) });
    expect((await handler(new Request(start, { method: "POST" }))).status).to.equal(403);
    expect(child.send.callCount).to.equal(0);

    const bad = `${start}&token=${"0".repeat(48)}`;
    expect((await handler(new Request(bad, { method: "POST" }))).status).to.equal(403);

    const pause = apiQuery({ api: "pause", hash: HASH_HEX, token });
    const res = await handler(new Request(pause, { method: "POST" }));
    expect(res.status).to.equal(200);
    const body = await jsonBody(res);
    expect(body).to.include({ success: true, paused: true });
    const ipc = child.send.getCalls().map((c) => c.args[0]);
    expect(ipc.some((m) => m.action === "pause" && m.hash === HASH_HEX)).to.equal(true);
  });

  it("status is 404 until worker pushes a status-update, then reads from cache", async () => {
    const { handler, child } = await loadHandler();
    const st = apiQuery({ api: "status", hash: HASH_HEX });
    expect((await handler(new Request(st))).status).to.equal(404);

    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      name: "Fixture",
      progress: 0.5,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      done: false,
      paused: false,
      files: [],
      magnetURI: MAGNET,
      downloadPath: "/tmp",
    });

    const res = await handler(new Request(st));
    expect(res.status).to.equal(200);
    const data = await jsonBody(res);
    expect(data.name).to.equal("Fixture");
    expect(data.infoHash).to.equal(HASH_HEX);
    expect(data).to.not.have.property("type");
  });

  it("start merges custom tr= with defaults and returns success", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const magnet = `${MAGNET}&tr=${encodeURIComponent("udp://tracker.example.com:6969/announce")}`;
    const url = apiQuery({ api: "start", magnet: encodeURIComponent(magnet), token });
    const res = await handler(new Request(url, { method: "POST" }));
    expect(res.status).to.equal(200);
    const body = await jsonBody(res);
    expect(body.success).to.equal(true);
    expect(body.infoHash).to.equal(HASH_HEX);

    const start = child.send.getCalls().map((c) => c.args[0]).find((m) => m.action === "start");
    expect(start.announce.length).to.be.greaterThan(0);
    expect(start.announce.join(",")).to.include("tracker.example.com");
  });

  it("seed hits the worker with action seed", async () => {
    const { handler, child } = await loadHandler();
    const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
    const url = apiQuery({ api: "seed", magnet: encodeURIComponent(MAGNET), hash: HASH_HEX, token });
    const res = await handler(new Request(url, { method: "POST" }));
    expect(res.status).to.equal(200);
    expect((await jsonBody(res)).mode).to.equal("seed");
    const seed = child.send.getCalls().map((c) => c.args[0]).find((m) => m.action === "seed");
    expect(seed.magnetUri).to.include("urn:btih");
  });

  it("bt://hash/path streams a file when cache lists it and bytes exist on disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-serve-"));
    const rel = "readme.txt";
    fs.writeFileSync(path.join(dir, rel), "hello-bt-file", "utf8");

    try {
      const { handler, child } = await loadHandler({ downloadsDir: dir });
      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        name: "T",
        downloadPath: dir,
        progress: 1,
        downloaded: 10,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        done: true,
        paused: false,
        files: [{ index: 0, name: rel, path: rel, length: 14, downloaded: 14, progress: 1 }],
        magnetURI: MAGNET,
      });

      const res = await handler(new Request(`bt://${HASH_HEX}/${rel}`));
      expect(res.status).to.equal(200);
      expect(await res.text()).to.equal("hello-bt-file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects path segments that escape the torrent root (../ after normalize)", async () => {
    const { handler, child } = await loadHandler();
    child.emit("message", {
      type: "status-update",
      infoHash: HASH_HEX,
      downloadPath: "/tmp",
      files: [{ index: 0, name: "x", path: "x", length: 1, downloaded: 0, progress: 0 }],
      magnetURI: MAGNET,
    });
    const res = await handler(new Request(`bt://${HASH_HEX}/%2E%2E%2Fsecret`));
    expect(res.status).to.equal(400);
    expect(await res.text()).to.include("Invalid torrent file path");
  });

  it("resume + worker miss re-adds a download via start from cached magnet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-resume-dl-"));
    try {
      let resumes = 0;
      const { handler, child } = await loadHandler({
        replyAs(proc) {
          return (msg) => {
            const { id, action } = msg;
            if (!id) return;
            if (action === "resume") {
              resumes += 1;
              proc.emit("message", { id, error: "Torrent not found" });
              return;
            }
            if (action === "start") {
              proc.emit("message", {
                id,
                type: "started",
                infoHash: HASH_HEX,
                magnetURI: decodeURIComponent(msg.magnetUri),
              });
              return;
            }
            defaultWorkerReplies(proc)(msg);
          };
        },
      });

      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        mode: "download",
        magnetURI: MAGNET,
        downloadPath: dir,
        done: false,
        paused: true,
        files: [],
        progress: 0,
        downloaded: 0,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
      });

      const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
      const res = await handler(new Request(apiQuery({ api: "resume", hash: HASH_HEX, token }), { method: "POST" }));
      expect(res.status).to.equal(200);
      expect((await jsonBody(res)).success).to.equal(true);
      expect(resumes).to.equal(1);
      const actions = child.send.getCalls().map((c) => c.args[0].action);
      expect(actions).to.include.members(["resume", "start"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume + worker miss re-adds seeding via seed from cached magnet when mode was seed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peersky-bt-resume-seed-"));
    try {
      let resumes = 0;
      const { handler, child } = await loadHandler({
        replyAs(proc) {
          return (msg) => {
            const { id, action } = msg;
            if (!id) return;
            if (action === "resume") {
              resumes += 1;
              proc.emit("message", { id, error: "Torrent not found" });
              return;
            }
            if (action === "seed") {
              proc.emit("message", {
                id,
                type: "started",
                infoHash: HASH_HEX,
                magnetURI: decodeURIComponent(msg.magnetUri),
                mode: "seed",
              });
              return;
            }
            defaultWorkerReplies(proc)(msg);
          };
        },
      });

      child.emit("message", {
        type: "status-update",
        infoHash: HASH_HEX,
        mode: "seed",
        magnetURI: MAGNET,
        downloadPath: dir,
        done: true,
        paused: true,
        files: [],
        progress: 1,
        downloaded: 100,
        uploaded: 10,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
      });

      const token = apiToken(await (await handler(new Request(`bt://${HASH_HEX}/`))).text());
      const res = await handler(new Request(apiQuery({ api: "resume", hash: HASH_HEX, token }), { method: "POST" }));
      expect(res.status).to.equal(200);
      expect(resumes).to.equal(1);
      const actions = child.send.getCalls().map((c) => c.args[0].action);
      expect(actions).to.include.members(["resume", "seed"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("base32 btih in hostname still renders a magnet link in the UI", async () => {
    const b32 = "YNKEUYQYHGNZBULYSH6QUYSTMFPUVV52";
    const { handler } = await loadHandler();
    const html = await (await handler(new Request(`bt://${b32}/`))).text();
    expect(html).to.include("magnet:?xt=urn:btih:");
  });
});
