import json
import random
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 8765
PROTOCOL_VERSION = "monitor.v1"
RUNTIME_FILE = Path(__file__).with_name("runtime_state.json")

STATE_ORDER = ["active", "asr", "vad", "sleep"]
STATE_PROFILE = {
    "active": {
        "legacy_delta": 1.0,
        "smart_delta": 1.0,
        "latency": {"roomJoinMs": 0, "aiPostProcessBootMs": 0, "firstResponseMs": 120},
        "log": "用户有效输入触发追问，智能体保持全活跃态。"
    },
    "asr": {
        "legacy_delta": 1.0,
        "smart_delta": 0.5,
        "latency": {"roomJoinMs": 0, "aiPostProcessBootMs": 120, "firstResponseMs": 150},
        "log": "ASR 监听态收到有效语义，开始补齐 AI 后处理链路。"
    },
    "vad": {
        "legacy_delta": 1.0,
        "smart_delta": 0.2,
        "latency": {"roomJoinMs": 0, "aiPostProcessBootMs": 520, "firstResponseMs": 240},
        "log": "VAD 待命态检测到唤醒，需要重新拉起 AI 后处理服务。"
    },
    "sleep": {
        "legacy_delta": 1.0,
        "smart_delta": 0.01,
        "latency": {"roomJoinMs": 520, "aiPostProcessBootMs": 480, "firstResponseMs": 280},
        "log": "深度休眠态命中唤醒，智能体先入房再拉起 AI 后处理。"
    }
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def now_text():
    return datetime.now().strftime("%H:%M:%S")


def jitter(value):
    if value <= 0:
        return 0
    swing = 0.1 + random.random() * 0.1
    direction = -1 if random.random() < 0.5 else 1
    return max(0, round(value * (1 + direction * swing)))


def default_runtime():
    return {
        "tick": 0,
        "currentState": "active",
        "silenceElapsed": 0,
        "legacyCost": 0,
        "smartCost": 0,
        "elapsedSeconds": 0,
        "roomId": "room-9527",
        "userId": "user-boss"
    }


def load_runtime():
    if not RUNTIME_FILE.exists():
        state = default_runtime()
        save_runtime(state)
        return state

    try:
        return json.loads(RUNTIME_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        state = default_runtime()
        save_runtime(state)
        return state


def save_runtime(state):
    RUNTIME_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def next_state(current):
    index = STATE_ORDER.index(current)
    roll = random.random()
    if roll < 0.38:
        return "active"
    if roll < 0.58:
        return STATE_ORDER[min(index + 1, len(STATE_ORDER) - 1)]
    if roll < 0.76:
        return STATE_ORDER[max(index - 1, 0)]
    return current


def build_snapshot(subscribe_payload):
    runtime = load_runtime()
    runtime["tick"] += 1
    runtime["roomId"] = subscribe_payload.get("roomId") or runtime["roomId"]
    runtime["userId"] = subscribe_payload.get("userId") or runtime["userId"]
    runtime["elapsedSeconds"] += 5

    runtime["currentState"] = next_state(runtime["currentState"])
    runtime["silenceElapsed"] = {
        "active": random.randint(0, 55),
        "asr": random.randint(60, 88),
        "vad": random.randint(90, 116),
        "sleep": random.randint(118, 120)
    }[runtime["currentState"]]

    profile = STATE_PROFILE[runtime["currentState"]]
    runtime["legacyCost"] = round(runtime["legacyCost"] + profile["legacy_delta"] * 0.18 * 5, 2)
    runtime["smartCost"] = round(runtime["smartCost"] + profile["smart_delta"] * 0.18 * 5, 2)
    save_runtime(runtime)

    latency = profile["latency"]
    latency_sample = {
        "fromState": runtime["currentState"],
        "source": "python-mock-server",
        "roomJoinMs": jitter(latency["roomJoinMs"]),
        "aiPostProcessBootMs": jitter(latency["aiPostProcessBootMs"]),
        "firstResponseMs": jitter(latency["firstResponseMs"])
    }

    return {
        "type": "monitor.snapshot",
        "version": PROTOCOL_VERSION,
        "source": "python-mock-server",
        "generatedAt": now_iso(),
        "connected": True,
        "currentState": runtime["currentState"],
        "silenceElapsed": runtime["silenceElapsed"],
        "legacyCost": runtime["legacyCost"],
        "smartCost": runtime["smartCost"],
        "elapsedSeconds": runtime["elapsedSeconds"],
        "latencySample": latency_sample,
        "logs": [
            {
                "side": "engine",
                "text": "[" + runtime["roomId"] + "] " + profile["log"]
            },
            {
                "side": "business",
                "text": "已向前端回传 " + PROTOCOL_VERSION + " 快照，第 " + str(runtime["tick"]) + " 次刷新。",
                "highlight": runtime["currentState"] == "sleep"
            }
        ]
    }


class MonitorHandler(BaseHTTPRequestHandler):
    server_version = "MonitorMock/1.0"

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        super().end_headers()

    def write_json(self, payload, status=200):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
          self.write_json({"ok": True, "service": "monitor-mock", "version": PROTOCOL_VERSION})
          return

        if parsed.path == "/api/monitor":
            query = parse_qs(parsed.query)
            payload = {
                "type": "monitor.subscribe",
                "version": PROTOCOL_VERSION,
                "transport": "http",
                "appId": first_value(query.get("appId")),
                "appKey": first_value(query.get("appKey")),
                "roomId": first_value(query.get("roomId")) or "room-9527",
                "userId": first_value(query.get("userId")) or "user-boss"
            }
            self.write_json(build_snapshot(payload))
            return

        self.write_json({"error": "not_found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/monitor":
            self.write_json({"error": "not_found"}, 404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"

        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.write_json({"error": "invalid_json"}, 400)
            return

        if payload.get("type") != "monitor.subscribe":
            self.write_json({"error": "invalid_type", "expected": "monitor.subscribe"}, 400)
            return

        if payload.get("version") != PROTOCOL_VERSION:
            self.write_json({"error": "invalid_version", "expected": PROTOCOL_VERSION}, 400)
            return

        self.write_json(build_snapshot(payload))

    def log_message(self, format_text, *args):
        print("[" + now_text() + "] " + format_text % args)


def first_value(values):
    return values[0] if values else ""


def main():
    server = ThreadingHTTPServer((HOST, PORT), MonitorHandler)
    print("monitor mock server running at http://%s:%s" % (HOST, PORT))
    print("health: http://%s:%s/health" % (HOST, PORT))
    print("snapshot: http://%s:%s/api/monitor" % (HOST, PORT))
    server.serve_forever()


if __name__ == "__main__":
    main()
