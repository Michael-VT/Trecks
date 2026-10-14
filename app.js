// Trecks Visualizer: карта + выбор треков из каталога (tracks/, newtreks/).
// Каталог с анонсом приходит с serve.py (/api/tracks.json);
// без сервера — fallback на демонстрационные tracks/route*.

const map = L.map("map", { preferCanvas: true }).setView([39.36, -9.37], 12);

const baseLayers = {
    "Карта": L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { attribution: "© OpenStreetMap", maxZoom: 19 }),
    "Спутник": L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Esri, Maxar, Earthstar Geographics", maxZoom: 19 }),
    "Рельеф": L.tileLayer(
        "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        { attribution: "© OpenTopoMap (CC-BY-SA)", maxZoom: 17 }),
};

const labelOverlay = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Esri", maxZoom: 19 });

baseLayers["Карта"].addTo(map);

L.control.layers(baseLayers, { "Названия (на спутник)": labelOverlay },
                  { position: "bottomright" }).addTo(map);

let index = [];              // каталог треков (анонсы)
const byId = new Map();
const selected = new Set();  // id выбранных треков
const pointsCache = new Map(); // id -> точки
let tracks = [];             // выбранные: [{ id, title, points }]

let currentMode = "speed";
let lineWeight = 6;          // толщина линии трека (2..32)
let polylines = [];
let pointMarkers = [];
let statsVisible = false;
let typeFilter = "Все";
let query = "";
let elevationFix = false;    // поправка высоты: минимум выбранного -> 0
let elevationOffset = 0;

// ----------------------------
// UI-элементы
// ----------------------------

const tooltip = document.getElementById("tooltip");
const listEl = document.getElementById("tracklist");
const chipsEl = document.getElementById("chips");
const modesEl = document.getElementById("modes");
const selInfoEl = document.getElementById("selection-info");
const searchEl = document.getElementById("search");

const legend = document.createElement("div");
legend.id = "legend";
const statsPanel = document.createElement("div");
statsPanel.id = "stats";
map.getContainer().append(legend, statsPanel);

// ----------------------------
// Helpers
// ----------------------------

function haversine(p1, p2) {
    const R = 6371000;

    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lon - p1.lon) * Math.PI / 180;

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(p1.lat * Math.PI / 180) *
        Math.cos(p2.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolateColor(ratio) {

    ratio = Math.max(0, Math.min(1, ratio));

    let r, g;

    if (ratio < 0.5) {
        r = Math.floor(255 * (ratio * 2));
        g = 255;
    } else {
        r = 255;
        g = Math.floor(255 * (1 - (ratio - 0.5) * 2));
    }

    return `rgb(${r},${g},0)`;
}

function format(v, digits = 1) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Number(v).toFixed(digits);
}

function formatDuration(sec) {
    if (!sec) return "-";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function formatDistance(m) {
    if (!m) return "-";
    return (m / 1000).toFixed(1) + " км";
}

// ----------------------------
// GPX / TCX / KML parsing
// ----------------------------

async function loadFile(url) {

    const response = await fetch(url);

    if (!response.ok) {
        console.error("Cannot load:", url);
        return [];
    }

    const text = await response.text();

    const xml = new DOMParser().parseFromString(text, "text/xml");

    const points = [];

    // ---------------- GPX ----------------

    if (url.toLowerCase().endsWith(".gpx")) {

        xml.querySelectorAll("trkpt").forEach(pt => {

            const lat = parseFloat(pt.getAttribute("lat"));
            const lon = parseFloat(pt.getAttribute("lon"));

            const ele = parseFloat(
                pt.querySelector("ele")?.textContent
            );

            const time =
                pt.querySelector("time")?.textContent || null;

            const hr =
                parseFloat(
                    pt.querySelector("hr")?.textContent
                ) || null;

            if (!isNaN(lat) && !isNaN(lon)) {

                points.push({
                    lat,
                    lon,
                    ele: isNaN(ele) ? null : ele,
                    time,
                    hr
                });
            }
        });
    }

    // ---------------- TCX ----------------

    else if (url.toLowerCase().endsWith(".tcx")) {

        xml.querySelectorAll("Trackpoint").forEach(pt => {

            const lat = parseFloat(
                pt.querySelector("LatitudeDegrees")?.textContent
            );

            const lon = parseFloat(
                pt.querySelector("LongitudeDegrees")?.textContent
            );

            const ele = parseFloat(
                pt.querySelector("AltitudeMeters")?.textContent
            );

            const time =
                pt.querySelector("Time")?.textContent || null;

            const hr =
                parseFloat(
                    pt.querySelector("HeartRateBpm Value")?.textContent
                ) || null;

            if (!isNaN(lat) && !isNaN(lon)) {

                points.push({
                    lat,
                    lon,
                    ele: isNaN(ele) ? null : ele,
                    time,
                    hr
                });
            }
        });
    }

    // ---------------- KML ----------------

    else if (url.toLowerCase().endsWith(".kml")) {

        xml.querySelectorAll("coordinates").forEach(c => {

            const raw = c.textContent.trim();

            raw.split(/\s+/).forEach(line => {

                const parts = line.split(",");

                const lon = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                const ele = parseFloat(parts[2]);

                if (!isNaN(lat) && !isNaN(lon)) {

                    points.push({
                        lat,
                        lon,
                        ele: isNaN(ele) ? null : ele,
                        time: null,
                        hr: null
                    });
                }
            });
        });
    }

    return points;
}

// ----------------------------
// Calculate metrics
// ----------------------------

function prepareTrack(points) {

    let totalDistance = 0;

    for (let i = 1; i < points.length; i++) {

        const p1 = points[i - 1];
        const p2 = points[i];

        const dist = haversine(p1, p2);

        totalDistance += dist;

        p2.distance = totalDistance;

        // speed

        let speed = null;

        if (p1.time && p2.time) {

            const dt =
                (new Date(p2.time) - new Date(p1.time)) / 1000;

            if (dt > 0) {
                speed = dist / dt * 3.6;
            }
        }

        p2.speed = speed;
    }

    return points;
}

// ----------------------------
// Draw track
// ----------------------------

function drawTracks(mode) {

    currentMode = mode;

    polylines.forEach(p => map.removeLayer(p));
    pointMarkers.forEach(p => map.removeLayer(p));

    polylines = [];
    pointMarkers = [];

    const values = [];

    tracks.forEach(track => {

        for (let i = 1; i < track.points.length; i++) {

            const p = track.points[i];

            let v = null;

            if (mode === "speed") v = p.speed;
            if (mode === "height") v = p.ele;
            if (mode === "pulse") v = p.hr;

            if (v !== null && !isNaN(v)) {
                values.push(v);
            }
        }
    });

    // поправка высоты: сдвиг выбранного набора так, чтобы минимум = 0
    elevationOffset = 0;

    if (mode === "height" && elevationFix && values.length) {
        elevationOffset = Math.min(...values);
        if (elevationOffset) {
            for (let i = 0; i < values.length; i++) {
                values[i] -= elevationOffset;
            }
        }
    }


    const hasData = values.length > 1;
    const min = hasData ? Math.min(...values) : 0;
    const max = hasData ? Math.max(...values) : 1;

    const unit = mode === "speed" ? "км/ч"
               : mode === "height" ? "м"
               : "уд/мин";
    const title = mode === "speed" ? "СКОРОСТЬ"
                : mode === "height" ? "ВЫСОТА"
                : "ПУЛЬС";

    legend.innerHTML = hasData
        ? `<b>${title}</b><br>
           Min: ${format(min)} · Max: ${format(max)} ${unit}<br>
           <div style="
               width:200px; height:18px; margin-top:6px;
               background:linear-gradient(to right, green, yellow, red);
               border:1px solid #000;
           "></div>`
        : `<b>${title}</b><br>нет данных`;

    tracks.forEach(track => {

        for (let i = 1; i < track.points.length; i++) {

            const p1 = track.points[i - 1];
            const p2 = track.points[i];

            let value = null;

            if (mode === "speed") value = p2.speed;
            if (mode === "height") value = p2.ele - elevationOffset;
            if (mode === "pulse") value = p2.hr;

            const noData = value === null || isNaN(value);

            // без данных (например KML без времени) — нейтральный серый
            const color = noData
                ? "#9aa0a6"
                : interpolateColor((value - min) / (max - min));

            const line = L.polyline(
                [
                    [p1.lat, p1.lon],
                    [p2.lat, p2.lon]
                ],
                {
                    color,
                    weight: lineWeight,
                    opacity: 0.9
                }
            ).addTo(map);

            polylines.push(line);

            // hover point

            const marker = L.circleMarker(
                [p2.lat, p2.lon],
                {
                    radius: Math.max(4, lineWeight / 2),
                    opacity: 0,
                    fillOpacity: 0
                }
            ).addTo(map);

            let timer = null;

            marker.on("mouseover", e => {

                timer = setTimeout(() => {

                    tooltip.style.display = "block";

                    tooltip.style.left = e.originalEvent.pageX + 15 + "px";
                    tooltip.style.top = e.originalEvent.pageY + 15 + "px";

                    tooltip.innerHTML = `
                        <b>${track.title}</b><br>
                        Speed: ${format(p2.speed)} km/h<br>
                        Height: ${format(p2.ele - elevationOffset)} m<br>
                        Pulse: ${format(p2.hr)} bpm<br>
                        Distance: ${format((p2.distance || 0)/1000)} km<br>
                        Time: ${p2.time || "-"}<br>
                        Lat: ${format(p2.lat, 5)}<br>
                        Lon: ${format(p2.lon, 5)}<br>
                        <i>клик по точке — панорама Google</i>
                    `;

                }, 2000);
            });

            marker.on("mouseout", () => {

                clearTimeout(timer);

                tooltip.style.display = "none";
            });

            marker.on("click", () => {
                window.open(
                    `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p2.lat},${p2.lon}`,
                    "_blank"
                );
            });

            pointMarkers.push(marker);
        }
    });
}

// ----------------------------
// Statistics
// ----------------------------

function showStatistics() {

    // дистанция/время — итоги устройства из каталога (совпадают с анонсом),
    // иначе — расчёт по точкам
    let totalDistance = 0;
    let totalDuration = 0;
    let heights = [];
    let pulse = [];
    let maxSpeed = null;

    tracks.forEach(track => {

        const entry = byId.get(track.id);

        if (entry?.distance) {
            totalDistance += entry.distance;
        }
        if (entry?.duration) {
            totalDuration += entry.duration;
        }

        track.points.forEach(p => {
            if (p.hr) pulse.push(p.hr);
        });

        heights = heights.concat(
            track.points.map(p => p.ele).filter(v => v !== null && !isNaN(v))
        );

        if (!entry?.distance) {
            const last = track.points[track.points.length - 1];
            if (last?.distance) totalDistance += last.distance;
        }

        if (!entry?.duration) {
            const t1 = track.points.find(p => p.time)?.time;
            const t2 = [...track.points].reverse().find(p => p.time)?.time;
            if (t1 && t2) {
                totalDuration += (new Date(t2) - new Date(t1)) / 1000;
            }
        }

        // макс. скорость по окну в 10 точек — гасит выбросы GPS
        const pts = track.points;

        for (let i = 0; i + 10 < pts.length; i += 5) {

            const a = pts[i];
            const b = pts[i + 10];

            if (a.time && b.time) {

                const dt = (new Date(b.time) - new Date(a.time)) / 1000;

                if (dt > 0) {
                    const v = ((b.distance || 0) - (a.distance || 0)) / dt * 3.6;
                    if (v > (maxSpeed || 0)) maxSpeed = v;
                }
            }
        }
    });


    const avg = arr =>
        arr.length
            ? arr.reduce((a,b)=>a+b,0) / arr.length
            : 0;

    const avgSpeed = totalDuration > 0
        ? totalDistance / totalDuration * 3.6
        : 0;

    // поправка высоты: минимум выбранного набора становится 0
    const eleShift = elevationFix && heights.length ? Math.min(...heights) : 0;

    statsPanel.innerHTML = `
        <h3>Route Statistics</h3>

        <table>

        <tr>
            <td>Total Distance</td>
            <td>${format(totalDistance / 1000)} km</td>
        </tr>

        <tr>
            <td>Total Duration</td>
            <td>${formatDuration(totalDuration)}</td>
        </tr>

        <tr>
            <td>Average Speed</td>
            <td>${format(avgSpeed)} km/h</td>
        </tr>

        <tr>
            <td>Max Speed</td>
            <td>${format(maxSpeed)} km/h</td>
        </tr>

        <tr>
            <td>Min Height${elevationFix ? " (поправка)" : ""}</td>
            <td>${format(heights.length ? Math.min(...heights) - eleShift : null)} m</td>
        </tr>

        <tr>
            <td>Max Height${elevationFix ? " (поправка)" : ""}</td>
            <td>${format(heights.length ? Math.max(...heights) - eleShift : null)} m</td>
        </tr>

        <tr>
            <td>Average Pulse</td>
            <td>${pulse.length ? format(avg(pulse)) : "-"} bpm</td>
        </tr>

        </table>

        <br>

        <b>Keys:</b><br>
        S = speed<br>
        H = height<br>
        P = pulse<br>
        T = statistics
    `;

    statsVisible = !statsVisible;

    statsPanel.style.display =
        statsVisible ? "block" : "none";
}

// ----------------------------
// Каталог: список, фильтры, выбор
// ----------------------------

function renderChips() {

    const types = ["Все", ...new Set(index.map(t => t.type))];

    chipsEl.innerHTML = "";

    types.forEach(t => {

        const chip = document.createElement("button");
        chip.className = "chip" + (t === typeFilter ? " active" : "");
        chip.textContent =
            t === "Все" ? "Все" : `${t} (${index.filter(x => x.type === t).length})`;

        chip.onclick = () => {
            typeFilter = t;
            renderChips();
            renderList();
        };

        chipsEl.appendChild(chip);
    });
}

function visibleEntries() {
    return index.filter(t => {

        if (typeFilter !== "Все" && t.type !== typeFilter) return false;

        if (query) {
            const hay = `${t.title} ${t.date || ""} ${t.type}`.toLowerCase();
            if (!hay.includes(query)) return false;
        }

        return true;
    });
}

function renderList() {

    listEl.innerHTML = "";

    visibleEntries().forEach(t => {

        const row = document.createElement("div");
        row.className = "track" + (selected.has(t.id) ? " selected" : "");
        row.dataset.id = t.id;

        row.innerHTML = `
            <div class="track-main">
                <span class="track-title">${t.title}</span>
                <span class="track-date">${t.date ? t.date.slice(8,10) + "." + t.date.slice(5,7) + "." + t.date.slice(0,4) : ""}</span>
            </div>
            <div class="track-sub">
                <span class="badge ${t.type}">${t.type}</span>
                ${formatDistance(t.distance)}
                · ${formatDuration(t.duration)}
                · ${format(t.avgSpeed)} км/ч${t.maxSpeed ? " (макс " + format(t.maxSpeed) + ")" : ""}
                ${t.climb ? " · ↑" + format(t.climb) + " м" : ""}
            </div>
        `;

        listEl.appendChild(row);
    });

    if (!index.length) {
        listEl.innerHTML = `<div style="padding:16px;color:#888;font-size:13px">
            Каталог пуст. Положите .gpx/.tcx/.kml в tracks/ или newtreks/.
        </div>`;
    }
}

function renderSelectionInfo() {

    const count = selected.size;

    let dist = 0, dur = 0;

    selected.forEach(id => {
        const t = byId.get(id);
        if (t?.distance) dist += t.distance;
        if (t?.duration) dur += t.duration;
    });

    selInfoEl.textContent = count
        ? `Выбрано: ${count} · ${formatDistance(dist)} · ${formatDuration(dur)}`
        : "";
}

function renderModes() {

    modesEl.innerHTML = "";

    const modes = [
        ["speed", "Скорость"],
        ["height", "Высота"],
        ["pulse", "Пульс"],
    ].filter(([m]) => m !== "pulse" || index.some(t => t.hasHr));

    modes.forEach(([m, label]) => {

        const btn = document.createElement("button");
        btn.textContent = label;
        btn.className = m === currentMode ? "active" : "";

        btn.onclick = () => {
            drawTracks(m);
            renderModes();
            if (statsVisible) showStatistics(), statsVisible = true;
        };

        modesEl.appendChild(btn);
    });

    const fixBtn = document.createElement("button");
    fixBtn.textContent = "Поправка высоты";
    fixBtn.title = "Сместить высоты так, чтобы минимум выбранного = 0 (уровень моря)";
    fixBtn.className = elevationFix ? "active" : "";
    fixBtn.onclick = () => {
        elevationFix = !elevationFix;
        drawTracks(currentMode);
        renderModes();
        if (statsVisible) {
            showStatistics();
            statsVisible = true; // showStatistics переключает видимость
        }
    };
    modesEl.appendChild(fixBtn);

    const statsBtn = document.createElement("button");
    statsBtn.textContent = "Статистика";
    statsBtn.onclick = () => showStatistics();
    modesEl.appendChild(statsBtn);
}

const weightEl = document.getElementById("weight");
const weightLabel = document.getElementById("weight-label");

weightEl.addEventListener("input", () => {

    lineWeight = Number(weightEl.value);

    weightLabel.textContent = "Толщина линии: " + lineWeight;

    // обновление стиля существующих слоёв — без пересоздания
    polylines.forEach(p => p.setStyle({ weight: lineWeight }));
    pointMarkers.forEach(m =>
        m.setStyle({ radius: Math.max(4, lineWeight / 2) })
    );
});

// ----------------------------
// Проигрыватель маршрута
// ----------------------------

const SPEEDS = [1, 2, 4, 8, 16];

const player = {
    seq: [],       // точки выбранных треков по порядку
    idx: 0,
    playing: false,
    speed: 1,
    timer: null,
    marker: null,
};

const playerEl = document.createElement("div");
playerEl.id = "player";
playerEl.innerHTML = `
    <button id="pl-play" title="Идти по маршруту">▶</button>
    <button id="pl-speed" title="Скорость">×1</button>
    <button id="pl-stop" title="В начало">⏮</button>
    <span id="pl-info"></span>
`;
map.getContainer().appendChild(playerEl);

const plPlay = playerEl.querySelector("#pl-play");
const plSpeed = playerEl.querySelector("#pl-speed");
const plStop = playerEl.querySelector("#pl-stop");
const plInfo = playerEl.querySelector("#pl-info");

function playerInfo() {

    const p = player.seq[Math.max(0, player.idx - 1)];

    if (!p) {
        plInfo.textContent = tracks.length
            ? "▶ — идти по маршруту"
            : "выберите трек";
        return;
    }

    plInfo.textContent =
        `${format(p.speed)} км/ч · ` +
        `${format(p.ele - elevationOffset)} м · ` +
        `${format((p.distance || 0) / 1000)} км`;
}

function playerPause() {

    if (player.timer) {
        clearInterval(player.timer);
        player.timer = null;
    }

    player.playing = false;
    plPlay.textContent = "▶";
}

function playerTick() {

    const p = player.seq[player.idx];

    if (!p) {
        playerPause();
        return;
    }

    if (!player.marker) {
        player.marker = L.circleMarker([p.lat, p.lon], {
            radius: 9,
            color: "#fff",
            weight: 3,
            fillColor: "#2b5f9e",
            fillOpacity: 1,
        }).addTo(map);
    } else {
        player.marker.setLatLng([p.lat, p.lon]);
    }

    // камера следует за маркером
    map.setView([p.lat, p.lon],
                Math.max(map.getZoom(), 15),
                { animate: false });

    player.idx++;
    playerInfo();

    if (player.idx >= player.seq.length) {
        playerPause();
    }
}

function playerToggle() {

    if (!player.seq.length) return;

    if (player.playing) {
        playerPause();
        return;
    }

    if (player.idx >= player.seq.length) player.idx = 0;

    player.playing = true;
    plPlay.textContent = "⏸";

    const ms = 25 / player.speed;   // 40 точек/сек при ×1

    player.timer = setInterval(playerTick, ms);
}

function playerReset() {

    playerPause();

    player.idx = 0;
    player.seq = [];

    tracks.forEach(t => t.points.forEach(p => player.seq.push(p)));

    if (player.marker) {
        map.removeLayer(player.marker);
        player.marker = null;
    }

    playerInfo();
}

plPlay.onclick = playerToggle;

plSpeed.onclick = () => {

    const i = SPEEDS.indexOf(player.speed);

    player.speed = SPEEDS[(i + 1) % SPEEDS.length];
    plSpeed.textContent = "×" + player.speed;

    if (player.playing) {
        clearInterval(player.timer);
        player.timer = setInterval(playerTick, 25 / player.speed);
    }
};

plStop.onclick = playerReset;

async function ensureLoaded(id) {

    if (pointsCache.has(id)) return;

    const entry = byId.get(id);

    if (!entry) return;

    const points = await loadFile(encodeURI(entry.file));

    pointsCache.set(id, prepareTrack(points));
}

async function toggleTrack(id) {

    const row = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add("loading");

    try {
        if (selected.has(id)) {
            selected.delete(id);
        } else {
            await ensureLoaded(id);
            selected.add(id);
        }
    } finally {
        if (row) row.classList.remove("loading");
    }

    redraw();
}

function redraw() {

    tracks = [...selected]
        .map(id => ({
            id,
            title: byId.get(id)?.title || id,
            points: pointsCache.get(id),
        }))
        .filter(t => t.points && t.points.length > 1);

    drawTracks(currentMode);
    playerReset();

    if (statsVisible) {
        showStatistics();
        statsVisible = true; // showStatistics переключает видимость
    }

    const bounds = [];

    tracks.forEach(t =>
        t.points.forEach(p => bounds.push([p.lat, p.lon]))
    );

    if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] });

    renderList();
    renderSelectionInfo();
}

// ----------------------------
// События
// ----------------------------

listEl.addEventListener("click", e => {

    const row = e.target.closest(".track");

    if (row) toggleTrack(row.dataset.id);
});

searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    renderList();
});

document.getElementById("clear").onclick = () => {
    selected.clear();
    redraw();
};

function toggleSidebar() {

    document.getElementById("app").classList.toggle("collapsed");

    // карта меняет размер — Leaflet нужно об этом сказать
    setTimeout(() => map.invalidateSize(), 50);
}

document.getElementById("close-sidebar").onclick = toggleSidebar;
document.getElementById("open-sidebar").onclick = toggleSidebar;

document.addEventListener("keydown", e => {

    if (e.target.tagName === "INPUT") return;

    const k = e.key.toLowerCase();

    if (k === "s") drawTracks("speed"), renderModes();
    if (k === "h") drawTracks("height"), renderModes();
    if (k === "p") drawTracks("pulse"), renderModes();
    if (k === "t") showStatistics();
});

// ----------------------------
// Инициализация
// ----------------------------

(async function init() {

    let fromApi = false;

    try {

        const response = await fetch("api/tracks.json");

        if (response.ok) {

            const data = await response.json();

            if (data.tracks?.length) {
                index = data.tracks;
                fromApi = true;
                if (data.version) {
                    document.getElementById("ver").textContent =
                        "v" + data.version;
                }
            }
        }
    } catch (e) {
        // нет serve.py — работаем со старыми демонстрационными треками
    }

    if (!fromApi) {

        index = [
            "tracks/route1.gpx",
            "tracks/route2.tcx",
            "tracks/route3.kml"
        ].map(f => ({

            id: f.replace(/\.[^.]+$/, ""),
            file: f,
            format: f.split(".").pop(),
            title: f.split("/").pop().replace(/\.[^.]+$/, ""),
            type: "Трек",
            date: null,
            distance: null,
            duration: null,
            avgSpeed: null,
            maxSpeed: null,
            climb: null,
            hasHr: false,
        }));
    }

    index.forEach(t => byId.set(t.id, t));

    renderChips();
    renderModes();
    renderList();

    // старт: последний трек (или все демо-треки)
    if (fromApi && index.length) {
        await toggleTrack(index[0].id);
    } else {
        for (const t of index) {
            await ensureLoaded(t.id);
            selected.add(t.id);
        }
        redraw();
    }
})();
