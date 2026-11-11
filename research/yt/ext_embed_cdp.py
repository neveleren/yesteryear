"""Launch a standalone headless Chromium (Playwright's cached build, NOT the
Playwright MCP server) with one unpacked test extension, open the
extension page that iframes a YouTube embed, and report:
  - the Referer header actually sent on the /embed/ request
  - whether the embed response carries EMBEDDER_IDENTITY_MISSING_REFERRER
  - the visible text inside the YouTube iframe after a few seconds

Usage: python ext_embed_cdp.py <ext_dir> <profile_dir> <port>
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import urllib.request

import websockets

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1217\chrome-win64\chrome.exe")


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.pending = {}
        self.events = []
        self.listeners = []

    async def reader(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg and msg["id"] in self.pending:
                self.pending.pop(msg["id"]).set_result(msg)
            else:
                self.events.append(msg)
                for cb in list(self.listeners):
                    asyncio.create_task(cb(msg))

    async def send(self, method, params=None, session=None, timeout=20):
        self.n += 1
        mid = self.n
        fut = asyncio.get_event_loop().create_future()
        self.pending[mid] = fut
        payload = {"id": mid, "method": method, "params": params or {}}
        if session:
            payload["sessionId"] = session
        await self.ws.send(json.dumps(payload))
        return await asyncio.wait_for(fut, timeout)


async def main(ext_dir, profile_dir, port):
    shutil.rmtree(profile_dir, ignore_errors=True)
    args = [CHROME, "--headless=new", f"--remote-debugging-port={port}",
            f"--user-data-dir={profile_dir}", f"--disable-extensions-except={ext_dir}",
            f"--load-extension={ext_dir}", "--no-first-run", "--no-default-browser-check",
            "--mute-audio", "--lang=en-US", "--autoplay-policy=no-user-gesture-required", "about:blank"]
    if os.environ.get("UA_OVERRIDE"):
        args.insert(1, "--user-agent=" + os.environ["UA_OVERRIDE"])
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ver = None
        for _ in range(60):
            try:
                ver = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1))
                break
            except Exception:  # noqa: BLE001
                await asyncio.sleep(0.3)
        print("browser:", ver and ver.get("Browser"))
        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=100_000_000) as ws:
            cdp = CDP(ws)
            rtask = asyncio.create_task(cdp.reader())
            # find extension id via its service worker target
            ext_id = None
            for _ in range(40):
                t = await cdp.send("Target.getTargets")
                for ti in t["result"]["targetInfos"]:
                    if ti["url"].startswith("chrome-extension://"):
                        ext_id = ti["url"].split("/")[2]
                if ext_id:
                    break
                await asyncio.sleep(0.25)
            print("extension id:", ext_id)
            if not ext_id:
                return
            sessions = {}

            async def on_event(msg):
                if msg.get("method") == "Target.attachedToTarget":
                    sid = msg["params"]["sessionId"]
                    info = msg["params"]["targetInfo"]
                    sessions[sid] = info
                    await cdp.send("Network.enable", session=sid)
                    await cdp.send("Runtime.enable", session=sid)
                    await cdp.send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}, session=sid)
                    await cdp.send("Runtime.runIfWaitingForDebugger", session=sid)

            cdp.listeners.append(on_event)
            tgt = await cdp.send("Target.createTarget", {"url": "about:blank"})
            tid = tgt["result"]["targetId"]
            att = await cdp.send("Target.attachToTarget", {"targetId": tid, "flatten": True})
            psid = att["result"]["sessionId"]
            sessions[psid] = {"type": "page", "url": "parent"}
            await cdp.send("Network.enable", session=psid)
            await cdp.send("Page.enable", session=psid)
            await cdp.send("Runtime.enable", session=psid)
            await cdp.send("Log.enable", session=psid)
            await cdp.send("Target.setAutoAttach", {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}, session=psid)
            await cdp.send("Page.navigate", {"url": f"chrome-extension://{ext_id}/page.html"}, session=psid)
            await asyncio.sleep(float(os.environ.get('WAIT', '12')))

            # analyse network events for the embed document request
            reqs = {}
            for ev in cdp.events:
                m = ev.get("method", "")
                p = ev.get("params", {})
                sid = ev.get("sessionId")
                if m == "Network.requestWillBeSent" and "/embed/" in p.get("request", {}).get("url", ""):
                    reqs.setdefault(p["requestId"], {})
                    reqs[p["requestId"]].update(url=p["request"]["url"], sid=sid,
                                                 rwbs_headers=p["request"].get("headers", {}),
                                                 type=p.get("type"), initiator=p.get("initiator", {}).get("type"))
            for ev in cdp.events:
                m = ev.get("method", "")
                p = ev.get("params", {})
                if m == "Network.requestWillBeSentExtraInfo" and p.get("requestId") in reqs:
                    reqs[p["requestId"]]["wire_headers"] = p.get("headers", {})
                if m == "Network.responseReceived" and p.get("requestId") in reqs:
                    reqs[p["requestId"]]["status"] = p["response"]["status"]
                    reqs[p["requestId"]]["resp_sid"] = ev.get("sessionId")
            for rid, r in reqs.items():
                wire = r.get("wire_headers", {})
                ref_wire = {k: v for k, v in wire.items() if k.lower() == "referer"}
                ref_rwbs = {k: v for k, v in r.get("rwbs_headers", {}).items() if k.lower() == "referer"}
                print(f"EMBED REQUEST {r.get('url')}\n   type={r.get('type')} status={r.get('status')}\n"
                      f"   Referer on wire (ExtraInfo): {ref_wire or 'NONE'}\n   Referer in requestWillBeSent: {ref_rwbs or 'NONE'}")
                for sid in {r.get("resp_sid"), r.get("sid")} - {None}:
                    try:
                        body = await cdp.send("Network.getResponseBody", {"requestId": rid}, session=sid)
                        txt = body["result"].get("body", "")
                        print(f"   body via session {sessions.get(sid, {}).get('type')}: {len(txt)} chars; "
                              f"MISSING_REFERRER={'EMBEDDER_IDENTITY_MISSING_REFERRER' in txt}; "
                              f"previewOK={'previewPlayabilityStatus' in txt and 'playableInEmbed' in txt}")
                        break
                    except Exception as e:  # noqa: BLE001
                        print("   getResponseBody failed on", sid, e)
            # visible text inside iframe targets
            for sid, info in sessions.items():
                if info.get("type") == "iframe":
                    try:
                        ev = await cdp.send("Runtime.evaluate", {"expression": "location.href + ' || ' + (document.body ? document.body.innerText.replace(/\\s+/g,' ').slice(0,200) : '')", "returnByValue": True}, session=sid)
                        print("IFRAME TEXT:", ev["result"]["result"].get("value"))
                    except Exception as e:  # noqa: BLE001
                        print("iframe eval failed", e)
            try:
                lg = await cdp.send("Runtime.evaluate", {"expression": "JSON.stringify({api: window.__iframeApiLoaded, log: window.__log || null})", "returnByValue": True}, session=psid)
                print("PARENT __log:", lg["result"]["result"].get("value"))
            except Exception as e:  # noqa: BLE001
                print("parent eval failed", e)
            for ev in cdp.events:
                if ev.get("sessionId") == psid and ev.get("method") in ("Log.entryAdded", "Runtime.exceptionThrown", "Runtime.consoleAPICalled"):
                    pr = ev.get("params", {})
                    txt = pr.get("entry", {}).get("text") or json.dumps(pr)[:300]
                    print("PARENT CONSOLE:", txt[:300])
            print("attached targets:", [(v.get("type"), v.get("url", "")[:60]) for v in sessions.values()])
            rtask.cancel()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
        shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], int(sys.argv[3])))
