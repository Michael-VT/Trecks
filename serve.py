#!/usr/bin/env python3
"""Раздаёт проект Trecks в локальной сети + индексирует треки.

Запуск из любой директории:
    python3 serve.py [--port 8000] [--bind 0.0.0.0]

URL:
    /                  — визуализатор
    /api/tracks.json   — каталог треков с анонсом (длина, время, скорость)

Треки ищутся в tracks/ и newtreks/ (.gpx/.tcx/.kml). Форматы одной
активности с одинаковым именем файла объединяются в одну запись —
берётся самый богатый (GPX > TCX > KML). Итоговые значения (дистанция,
время, набор высоты) читаются из шапки экспорта Huawei; макс. скорость
и число точек считаются по точкам трека и кэшируются в .trackscache.json
(ключ — mtime + размер, поэтому пересчитываются только новые файлы).
"""

import argparse
import json
import math
import re
import socket
import threading
import xml.etree.ElementTree as ET
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip() \
    if (ROOT / "VERSION").exists() else "dev"
TRACK_DIRS = ("tracks", "newtreks")
CACHE_FILE = ROOT / ".trackscache.json"
CACHE_VERSION = 1
FORMAT_PRIORITY = {"tcx": 3, "gpx": 2, "kml": 1}  # TCX плотнее GPX по точкам
HEAD_CHUNK = 16384          # итоги Huawei лежат в начале файла
SPEED_WINDOW = 10           # точек для сглаживания макс. скорости
EARTH_R = 6371000.0

TYPE_KEYWORDS = (("бег", "Бег"), ("велосипед", "Велосипед"), ("ходьба", "Ходьба"))
DATE_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})")

_index_lock = threading.Lock()
_index = []
_cache = {"version": CACHE_VERSION, "entries": {}}


# ----------------------------
# Геометрия / разбор точек
# ----------------------------

def haversine(lat1, lon1, lat2, lon2):
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def localname(tag):
    return tag.rsplit("}", 1)[-1]


def parse_ts(text):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_points(path, fmt):
    """Точки трека: [(lat, lon, ts, ele, hr), ...]."""
    pts = []

    for _, elem in ET.iterparse(str(path), events=("end",)):
        name = localname(elem.tag)

        if fmt == "gpx" and name == "trkpt":
            try:
                lat = float(elem.get("lat"))
                lon = float(elem.get("lon"))
            except (TypeError, ValueError):
                continue
            ele = ts = None
            hr = False
            for ch in elem.iter():
                cn = localname(ch.tag)
                if cn == "ele" and ch.text:
                    try:
                        ele = float(ch.text)
                    except ValueError:
                        pass
                elif cn == "time":
                    ts = parse_ts(ch.text)
                elif cn == "hr" and ch.text:
                    hr = bool(float(ch.text))
            pts.append((lat, lon, ts, ele, hr))

        elif fmt == "tcx" and name == "Trackpoint":
            lat = lon = ele = None
            ts = None
            hr = False
            for ch in elem.iter():
                cn = localname(ch.tag)
                if cn == "LatitudeDegrees" and ch.text:
                    try:
                        lat = float(ch.text)
                    except ValueError:
                        pass
                elif cn == "LongitudeDegrees" and ch.text:
                    try:
                        lon = float(ch.text)
                    except ValueError:
                        pass
                elif cn == "AltitudeMeters" and ch.text:
                    try:
                        ele = float(ch.text)
                    except ValueError:
                        pass
                elif cn == "Time":
                    ts = parse_ts(ch.text)
                elif cn == "Value" and ch.text:
                    try:
                        hr = float(ch.text) > 0
                    except ValueError:
                        pass
            if lat is not None and lon is not None:
                pts.append((lat, lon, ts, ele, hr))

        elif fmt == "kml" and name == "coordinates":
            # Huawei пишет "lon,lat, ele" — высота отделена пробелом;
            # стандартный KML — "lon,lat[,ele]" через пробел.
            for token in (elem.text or "").split():
                parts = token.rstrip(",").split(",")
                if len(parts) >= 2:
                    try:
                        lon = float(parts[0])
                        lat = float(parts[1])
                    except ValueError:
                        continue
                    ele = None
                    if len(parts) > 2:
                        try:
                            ele = float(parts[2])
                        except ValueError:
                            pass
                    pts.append((lat, lon, None, ele, False))
                elif pts and pts[-1][3] is None:
                    # одиночное число — высота предыдущей точки
                    try:
                        prev = pts[-1]
                        pts[-1] = (prev[0], prev[1], prev[2],
                                   float(token), prev[4])
                    except ValueError:
                        pass

        if name in ("trkpt", "Trackpoint", "coordinates"):
            elem.clear()

    return pts


def summarize(pts):
    """Дистанция/длительность/скорости по точкам (fallback и дополнение)."""
    n = len(pts)
    out = {"points": n, "distance": None, "duration": None,
           "avgSpeed": None, "maxSpeed": None, "hasHr": any(p[4] for p in pts),
           "minEle": None, "maxEle": None}
    if n < 2:
        return out

    cum = [0.0] * n
    for i in range(1, n):
        cum[i] = cum[i - 1] + haversine(pts[i - 1][0], pts[i - 1][1],
                                        pts[i][0], pts[i][1])
    out["distance"] = cum[-1]

    eles = [p[3] for p in pts if p[3] is not None]
    if eles:
        out["minEle"] = min(eles)
        out["maxEle"] = max(eles)

    times = [p[2] for p in pts]
    valid = [t for t in times if t]
    if len(valid) >= 2:
        duration = (valid[-1] - valid[0]).total_seconds()
        if duration > 0:
            out["duration"] = duration
            out["avgSpeed"] = cum[-1] / duration * 3.6

    # макс. скорость по скользящему окну — гасит выбросы GPS
    best = 0.0
    for i in range(n - SPEED_WINDOW):
        j = i + SPEED_WINDOW
        t1, t2 = times[i], times[j]
        if t1 and t2:
            dt = (t2 - t1).total_seconds()
            if dt > 0:
                v = (cum[j] - cum[i]) / dt * 3.6
                best = max(best, v)
    out["maxSpeed"] = best or None

    return out


# ----------------------------
# Шапка файла (готовые итоги экспорта)
# ----------------------------

def _first_float(text, pattern):
    m = re.search(pattern, text)
    return float(m.group(1)) if m else None


def header_summary(path, fmt):
    try:
        with open(path, "rb") as f:
            head = f.read(HEAD_CHUNK).decode("utf-8", "replace")
    except OSError:
        return {}
    s = {}
    if fmt == "tcx":
        s["distance"] = _first_float(head, r"<DistanceMeters>([\d.]+)</DistanceMeters>")
        s["duration"] = _first_float(head, r"<TotalTimeSeconds>([\d.]+)</TotalTimeSeconds>")
        s["calories"] = _first_float(head, r"<Calories>(\d+)</Calories>")
        m = re.search(r'<Activity Sport="([^"]+)"', head)
        if m:
            s["sport"] = m.group(1)
        m = re.search(r"<Id>([^<]+)</Id>", head)
        if m:
            s["start"] = m.group(1)
    else:  # gpx / kml
        s["distance"] = _first_float(head, r"<totalDistance>([\d.]+)</totalDistance>")
        s["duration"] = _first_float(head, r"<totalTime>([\d.]+)</totalTime>")
        s["climb"] = _first_float(head, r"<cumulativeClimb>([\d.]+)</cumulativeClimb>")
    return {k: v for k, v in s.items() if v is not None}


def detect_type(stem, sport):
    text = f"{stem} {sport or ''}".lower()
    for kw, label in TYPE_KEYWORDS:
        if kw in text:
            return label
    return sport or "Трек"


# ----------------------------
# Индекс
# ----------------------------

def build_entry(tid, files, fmt, path):
    stem = path.stem
    head = header_summary(path, fmt)
    pts = parse_points(path, fmt)
    comp = summarize(pts)

    distance = head.get("distance", comp["distance"])
    duration = head.get("duration", comp["duration"])
    avg_speed = distance / duration * 3.6 if distance and duration else comp["avgSpeed"]

    m = DATE_RE.match(stem)
    if m:
        date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    elif head.get("start"):
        date = head["start"][:10]
    else:
        first_ts = next((p[2] for p in pts if p[2]), None)
        date = first_ts.date().isoformat() if first_ts else None


    return {
        "id": tid,
        "file": str(path.relative_to(ROOT)),
        "format": fmt,
        "also": sorted(e for e in files if e != fmt),
        "title": (DATE_RE.sub("", stem).strip() or stem),
        "type": detect_type(stem, head.get("sport")),
        "date": date,
        "distance": round(distance, 1) if distance else None,
        "duration": round(duration) if duration else None,
        "avgSpeed": round(avg_speed, 1) if avg_speed else None,
        "maxSpeed": round(comp["maxSpeed"], 1) if comp["maxSpeed"] else None,
        "climb": round(head["climb"], 1) if head.get("climb") else None,
        "calories": head.get("calories"),
        "points": comp["points"],
        "hasHr": comp["hasHr"],
        "minEle": round(comp["minEle"], 1) if comp["minEle"] is not None else None,
        "maxEle": round(comp["maxEle"], 1) if comp["maxEle"] is not None else None,
    }


def scan_files():
    groups = {}
    for d in TRACK_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in sorted(base.iterdir()):
            ext = p.suffix[1:].lower()
            if not p.is_file() or ext not in FORMAT_PRIORITY:
                continue
            tid = f"{d}/{p.stem}"
            groups.setdefault(tid, {"files": {}, "path": p})["files"][ext] = p
    return groups


def refresh_index(verbose=False):
    global _index
    with _index_lock:
        groups = scan_files()
        entries, changed = [], 0

        for tid, g in groups.items():
            fmt = max(g["files"], key=lambda e: FORMAT_PRIORITY[e])
            path = g["files"][fmt]
            try:
                st = path.stat()
            except OSError:
                continue
            key = f"{tid}.{fmt}"
            cached = _cache["entries"].get(key)
            if (cached and cached["mtime"] == int(st.st_mtime)
                    and cached["size"] == st.st_size):
                entries.append(cached["entry"])
                continue
            changed += 1
            entry = build_entry(tid, g["files"], fmt, path)
            _cache["entries"][key] = {
                "mtime": int(st.st_mtime), "size": st.st_size, "entry": entry,
            }
            entries.append(entry)

        live = {f"{e['id']}.{e['format']}" for e in entries}
        for key in list(_cache["entries"]):
            if key not in live:
                del _cache["entries"][key]

        entries.sort(key=lambda e: (e["date"] or "", e["title"]), reverse=True)
        _index = entries

        if changed:
            tmp = CACHE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_cache, ensure_ascii=False), encoding="utf-8")
            tmp.replace(CACHE_FILE)

        if verbose:
            print(f"Индекс треков: {len(entries)} шт. (пересчитано {changed})")


def api_tracks_json():
    refresh_index()
    with _index_lock:
        return json.dumps(
            {"version": VERSION, "count": len(_index), "tracks": _index},
            ensure_ascii=False).encode("utf-8")


def load_cache():
    global _cache
    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        if data.get("version") == CACHE_VERSION:
            _cache = data
    except (OSError, ValueError):
        pass


# ----------------------------
# HTTP
# ----------------------------

class Handler(SimpleHTTPRequestHandler):
    """Статика без кэширования + API каталога."""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/tracks.json":
            body = api_tracks_json()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))  # пакет не отправляется
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description="Serve Trecks on the LAN")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="0.0.0.0",
                        help="по умолчанию — все интерфейсы")
    args = parser.parse_args()

    load_cache()

    server = ThreadingHTTPServer(
        (args.bind, args.port),
        partial(Handler, directory=str(ROOT)),
    )

    def warm():
        try:
            refresh_index(verbose=True)
        except Exception as e:  # индексация не должна ронять сервер
            print("Индексация не удалась:", e)

    threading.Thread(target=warm, daemon=True).start()

    host = args.bind if args.bind != "0.0.0.0" else "127.0.0.1"
    print(f"Trecks v{VERSION}:  http://{host}:{args.port}/")
    ip = lan_address()
    if args.bind == "0.0.0.0" and ip:
        print(f"LAN:      http://{ip}:{args.port}/  <- для телефона и других устройств")
    print("Ctrl+C — остановить")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлен.")
        server.server_close()


if __name__ == "__main__":
    main()
