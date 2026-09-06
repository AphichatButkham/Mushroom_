const SERVICE_UUID   = "d4a10000-1000-4bbb-9000-00a1b2c3d4e5";
const CHAR_TELEMETRY = "d4a10001-1000-4bbb-9000-00a1b2c3d4e5";
const CHAR_CONFIG    = "d4a10002-1000-4bbb-9000-00a1b2c3d4e5";
 
let bleDevice = null;
let telemetryChar = null;
let configChar = null;
 
// ── ตัวแปรสำหรับ Chart ──
let trendChart = null;
const MAX_POINTS = 20;
let timeLabels = [];
let tempData = [];
let humData = [];
let soilData = [];
let tempOutData = [];
let humOutData = [];
let hasTelemetry = false;

// ── สถิติภาพรวม (Session summary) ──
let statSumTemp = 0;
let statSumHum = 0;
let statReadingCount = 0;
let statMistCycleCount = 0;
let statPrevMist = false;
let statStartTime = null;
let statUptimeTimer = null;

// ── Google Sheet logging ──
let sheetLogTimer = null;
let latestTelemetry = null;

// ── DOM refs ──
let dom = {};
 
// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    // ผูก DOM element หลังจากสร้างหน้าเว็บเสร็จ
    dom = {
        status: document.getElementById('bleStatusText'),
        badge: document.getElementById('connBadge'),
        btnConnect: document.getElementById('btnConnect'),
        btnSave: document.getElementById('btnSave'),
        btnDemo: document.getElementById('btnDemo'),
        btnDemoText: document.getElementById('btnDemoText'),
 
        valAir: document.getElementById('gaugeAirValue'),
        valHum: document.getElementById('gaugeHumValue'),
        valSoil: document.getElementById('gaugeSoilValue'),
        valAirOut: document.getElementById('gaugeAirOutValue'),
        valHumOut: document.getElementById('gaugeHumOutValue'),
 
        miniAir: document.getElementById('miniAir'),
        miniHum: document.getElementById('miniHum'),
        miniSoil: document.getElementById('miniSoil'),
        miniAirOut: document.getElementById('miniAirOut'),
        miniHumOut: document.getElementById('miniHumOut'),
        miniMist: document.getElementById('miniMist'),
        miniMistText: document.getElementById('miniMistText'),
 
        deltaTempChip: document.getElementById('deltaTempChip'),
        deltaHumChip: document.getElementById('deltaHumChip'),
 
        mistIcon: document.getElementById('mistIcon'),
        mistLabel: document.getElementById('mistLabel'),
        mistStateText: document.getElementById('mistStateText'),
 
        lastUpdated: document.getElementById('lastUpdated'),
        liveIndicator: document.getElementById('liveIndicator'),
        chartEmpty: document.getElementById('chartEmpty'),
        chartBadge: document.getElementById('chartBadge'),
 
        targetHum: document.getElementById('targetHum'),
        targetPreview: document.getElementById('targetPreview'),
        targetBar: document.getElementById('targetBar'),

        statAvgTemp: document.getElementById('statAvgTemp'),
        statAvgHum: document.getElementById('statAvgHum'),
        statMistCycles: document.getElementById('statMistCycles'),
        statUptime: document.getElementById('statUptime'),

        sheetEnable: document.getElementById('sheetEnable'),
        sheetUrl: document.getElementById('sheetUrl'),
        sheetInterval: document.getElementById('sheetInterval'),
        btnTestSheet: document.getElementById('btnTestSheet'),
        sheetStatus: document.getElementById('sheetStatus'),

        toast: document.getElementById('toast'),
        toastIcon: document.querySelector('#toast > i'),
    };

    initGauges();
    initChart();
    updateUIConnected(false);
    initSheetLogging();
 
    // อัปเดตตัวอย่างค่าความชื้นเป้าหมายทันทีที่ผู้ใช้พิมพ์ (ก่อนกดบันทึก)
    if (dom.targetHum) {
        dom.targetHum.addEventListener('input', () => {
            syncTargetDisplay(dom.targetHum.value);
            updateHumidityZone(Number(dom.targetHum.value) || 0);
        });
        syncTargetDisplay(dom.targetHum.value);
    }
});
 
// ── GAUGE (custom SVG arc, ไม่พึ่ง gauge.js) ──
// ปรับช่วงเกณฑ์ที่เหมาะสมของแต่ละเซนเซอร์ได้ตรงนี้
const GAUGE_DEFS = {
    air:    { elId: 'gaugeAir',    statusElId: 'airStatus',  min: 0, max: 50,  optimalMin: 22, optimalMax: 28,  colorLight: '#9fd9b8', colorDark: '#2f9e63', unit: '°C' },
    hum:    { elId: 'gaugeHum',    statusElId: 'humStatus',  min: 0, max: 100, optimalMin: 75, optimalMax: 100, colorLight: '#9fcbe6', colorDark: '#3b82c4', unit: '%RH' },
    soil:   { elId: 'gaugeSoil',   statusElId: 'soilStatus', min: 0, max: 50,  optimalMin: 20, optimalMax: 26,  colorLight: '#f0c98a', colorDark: '#e0973f', unit: '°C' },
    airOut: { elId: 'gaugeAirOut', statusElId: null, min: 0, max: 50,  optimalMin: 0, optimalMax: 0, colorLight: '#c9c6f2', colorDark: '#8b7fd6', unit: '°C' },
    humOut: { elId: 'gaugeHumOut', statusElId: null, min: 0, max: 100, optimalMin: 0, optimalMax: 0, colorLight: '#dcc6ec', colorDark: '#b48fd1', unit: '%RH' },
};

function pct(cfg, value) {
    return Math.max(0, Math.min(100, ((value - cfg.min) / (cfg.max - cfg.min)) * 100));
}

function buildGaugeSVG(key, cfg) {
    const zoneStart = pct(cfg, cfg.optimalMin);
    const zoneLen = Math.max(0, pct(cfg, cfg.optimalMax) - zoneStart);
    return `
    <svg viewBox="0 0 200 125" class="gauge-arc" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="grad-${key}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${cfg.colorLight}"/>
          <stop offset="100%" stop-color="${cfg.colorDark}"/>
        </linearGradient>
      </defs>
      <path class="gauge-zone" id="zone-${key}" d="M5,100 A95,95 0 0 1 195,100" pathLength="100"
            stroke="${cfg.colorDark}" stroke-width="5" stroke-linecap="round" fill="none"
            stroke-dasharray="${zoneLen} 100" stroke-dashoffset="${-zoneStart}" opacity="0.4"/>
      <path class="gauge-track" d="M20,100 A80,80 0 0 1 180,100" pathLength="100"
            stroke="#e7eeea" stroke-width="14" stroke-linecap="round" fill="none"/>
      <path class="gauge-value" id="value-${key}" d="M20,100 A80,80 0 0 1 180,100" pathLength="100"
            stroke="url(#grad-${key})" stroke-width="14" stroke-linecap="round" fill="none"
            stroke-dasharray="100" stroke-dashoffset="100"/>
      <text x="20" y="119" class="gauge-scale-label" text-anchor="start">${cfg.min}</text>
      <text x="180" y="119" class="gauge-scale-label" text-anchor="end">${cfg.max}</text>
    </svg>`;
}

function initGauges() {
    Object.keys(GAUGE_DEFS).forEach((key) => {
        const cfg = GAUGE_DEFS[key];
        const el = document.getElementById(cfg.elId);
        if (el) el.innerHTML = buildGaugeSVG(key, cfg);
    });
    updateHumidityZone(Number(dom.targetHum ? dom.targetHum.value : 75) || 75);
}

// อัปเดตวงแหวนช่วงเป้าหมาย + ป้ายกำกับของความชื้น ให้วิ่งตามค่าที่ผู้ใช้ตั้งไว้
function updateHumidityZone(targetHum) {
    const cfg = GAUGE_DEFS.hum;
    cfg.optimalMin = Math.max(cfg.min, Math.min(cfg.max, targetHum));
    cfg.optimalMax = cfg.max;
    const zoneEl = document.getElementById('zone-hum');
    if (zoneEl) {
        const zoneStart = pct(cfg, cfg.optimalMin);
        const zoneLen = Math.max(0, pct(cfg, cfg.optimalMax) - zoneStart);
        zoneEl.setAttribute('stroke-dasharray', `${zoneLen} 100`);
        zoneEl.setAttribute('stroke-dashoffset', String(-zoneStart));
    }
    const label = document.getElementById('humZoneLabel');
    if (label) label.textContent = `เป้าหมาย ≥${cfg.optimalMin}%`;
}

function gaugeStatus(cfg, value) {
    if (value < cfg.optimalMin) return { cls: 'status-low', text: 'ต่ำ' };
    if (value > cfg.optimalMax) return { cls: 'status-high', text: 'สูง' };
    return { cls: 'status-ok', text: 'ปกติ' };
}

function setGaugeValue(key, rawValue, statusElId) {
    const cfg = GAUGE_DEFS[key];
    if (!cfg) return;
    const value = Number(rawValue);
    const percent = pct(cfg, value);
    const valueEl = document.getElementById(`value-${key}`);
    if (valueEl) valueEl.setAttribute('stroke-dashoffset', String(100 - percent));

    const resolvedStatusElId = statusElId || cfg.statusElId;
    if (!resolvedStatusElId) return; // เซนเซอร์นอกตู้ไม่มีป้ายสถานะ

    const statusEl = document.getElementById(resolvedStatusElId);
    if (statusEl) {
        // ความชื้นใช้ตรรกะพิเศษ: ต่ำกว่าเป้าหมาย = กำลังพ่นหมอก, ถึงเป้าหมาย = เพียงพอ
        let status;
        if (key === 'hum') {
            status = value < cfg.optimalMin ? { cls: 'status-low', text: 'กำลังพ่นหมอก' } : { cls: 'status-ok', text: 'เพียงพอ' };
        } else {
            status = gaugeStatus(cfg, value);
        }
        statusEl.textContent = status.text;
        statusEl.className = 'gauge-status ' + status.cls;
    }
}

function resetGauges() {
    Object.keys(GAUGE_DEFS).forEach((key) => {
        const cfg = GAUGE_DEFS[key];
        const valueEl = document.getElementById(`value-${key}`);
        if (valueEl) valueEl.setAttribute('stroke-dashoffset', '100');
        if (!cfg.statusElId) return;
        const statusEl = document.getElementById(cfg.statusElId);
        if (statusEl) { statusEl.textContent = '--'; statusEl.className = 'gauge-status'; }
    });
}
 
// ── SESSION SUMMARY ──
function resetSessionStats() {
    statSumTemp = 0;
    statSumHum = 0;
    statReadingCount = 0;
    statMistCycleCount = 0;
    statPrevMist = false;

    if (dom.statAvgTemp) dom.statAvgTemp.textContent = '--';
    if (dom.statAvgHum) dom.statAvgHum.textContent = '--';
    if (dom.statMistCycles) dom.statMistCycles.textContent = '0';

    showToast('รีเซ็ตสถิติภาพรวมแล้ว', false);
}

function formatUptime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function startUptimeTimer() {
    statStartTime = Date.now();
    if (dom.statUptime) dom.statUptime.textContent = '00:00:00';
    clearInterval(statUptimeTimer);
    statUptimeTimer = setInterval(() => {
        if (dom.statUptime && statStartTime) {
            dom.statUptime.textContent = formatUptime(Date.now() - statStartTime);
        }
    }, 1000);
}

function stopUptimeTimer() {
    clearInterval(statUptimeTimer);
    statUptimeTimer = null;
    statStartTime = null;
    if (dom.statUptime) dom.statUptime.textContent = '00:00:00';
}

// ── CHART ──
function makeGradient(ctx, chartArea, colorHex, alphaTop, alphaBottom) {
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, hexToRgba(colorHex, alphaTop));
    gradient.addColorStop(1, hexToRgba(colorHex, alphaBottom));
    return gradient;
}

function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

// สีหลักของแต่ละเส้น ให้ตรงกับจุดสีใน legend chip
const SERIES_COLORS = {
    air:  '#2f9e63',
    hum:  '#3b82c4',
    soil: '#e0973f',
    airOut: '#8b7fd6',
    humOut: '#b48fd1',
};

function initChart() {
    const canvas = document.getElementById('trendChart');
    if (!canvas) return;
 
    const ctx = canvas.getContext('2d');
    trendChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'อุณหภูมิอากาศ (°C)',
                    data: [],
                    borderColor: SERIES_COLORS.air,
                    backgroundColor: (c) => c.chart.chartArea ? makeGradient(ctx, c.chart.chartArea, SERIES_COLORS.air, 0.28, 0.01) : 'transparent',
                    borderWidth: 3,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: SERIES_COLORS.air,
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2,
                    tension: 0.35,
                    fill: true,
                    yAxisID: 'yTemp',
                },
                {
                    label: 'ความชื้น (%)',
                    data: [],
                    borderColor: SERIES_COLORS.hum,
                    backgroundColor: (c) => c.chart.chartArea ? makeGradient(ctx, c.chart.chartArea, SERIES_COLORS.hum, 0.24, 0.01) : 'transparent',
                    borderWidth: 3,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: SERIES_COLORS.hum,
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2,
                    tension: 0.35,
                    fill: true,
                    yAxisID: 'yHum',
                },
                {
                    label: 'อุณหภูมิเห็ด (°C)',
                    data: [],
                    borderColor: SERIES_COLORS.soil,
                    backgroundColor: 'transparent',
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: SERIES_COLORS.soil,
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2,
                    tension: 0.35,
                    borderDash: [6, 3],
                    fill: false,
                    yAxisID: 'yTemp',
                },
                {
                    label: 'อุณหภูมิภายนอก (°C)',
                    data: [],
                    borderColor: SERIES_COLORS.airOut,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: SERIES_COLORS.airOut,
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2,
                    tension: 0.35,
                    borderDash: [2, 3],
                    fill: false,
                    yAxisID: 'yTemp',
                },
                {
                    label: 'ความชื้นภายนอก (%)',
                    data: [],
                    borderColor: SERIES_COLORS.humOut,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    pointHoverBackgroundColor: SERIES_COLORS.humOut,
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2,
                    tension: 0.35,
                    borderDash: [2, 3],
                    fill: false,
                    yAxisID: 'yHum',
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#ffffff',
                    titleColor: '#20362b',
                    bodyColor: '#20362b',
                    borderColor: '#deeee5',
                    borderWidth: 1,
                    padding: 10,
                    boxPadding: 5,
                    usePointStyle: true,
                    titleFont: { size: 10, weight: '600' },
                    bodyFont: { size: 10 },
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}`
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 9 }, color: '#8baa9a', maxTicksLimit: 8 }
                },
                yTemp: {
                    type: 'linear',
                    position: 'left',
                    min: 0,
                    max: 50,
                    grid: { color: 'rgba(0,0,0,0.045)' },
                    ticks: { font: { size: 9, weight: '600' }, color: SERIES_COLORS.air }
                },
                yHum: {
                    type: 'linear',
                    position: 'right',
                    min: 0,
                    max: 100,
                    grid: { drawOnChartArea: false },
                    ticks: { font: { size: 9, weight: '600' }, color: SERIES_COLORS.hum }
                }
            }
        }
    });
}
 
// คลิก legend chip เพื่อซ่อน/แสดงเส้นกราฟนั้นๆ (กันกราฟรกเมื่อมีหลายเส้น)
function toggleSeries(index, chipEl) {
    if (!trendChart) return;
    const meta = trendChart.getDatasetMeta(index);
    meta.hidden = !meta.hidden;
    trendChart.update();
    if (chipEl) chipEl.classList.toggle('muted', meta.hidden);
}

// ── BLE ──
async function toggleConnect() {
    if (demoInterval) stopDemoMode();

    if (!navigator.bluetooth) {
        showToast('เบราว์เซอร์ไม่รองรับ Web Bluetooth (ต้องใช้ Chrome/Edge และ HTTPS/localhost)', true);
        return;
    }
 
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
        return;
    }
 
    setConnecting(true);
 
    try {
        console.log('Requesting BLE Device...');
        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'ESP32_MUSHROOM' }],
            optionalServices: [SERVICE_UUID]
        });
 
        bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
 
        const server = await bleDevice.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
 
        telemetryChar = await service.getCharacteristic(CHAR_TELEMETRY);
        await telemetryChar.startNotifications();
        telemetryChar.addEventListener('characteristicvaluechanged', handleTelemetry);
 
        configChar = await service.getCharacteristic(CHAR_CONFIG);
        await readCurrentConfig();
 
        updateUIConnected(true);
        console.log('Connected successfully!');
        showToast('เชื่อมต่อสำเร็จ ✓', false);
    } catch (error) {
        console.error('Connection failed:', error);
        showToast('ไม่สามารถเชื่อมต่อได้: ' + error.message, true);
        setConnecting(false);
        updateUIConnected(false);
    }
}
 
function setConnecting(isConnecting) {
    if (!dom.btnConnect) return;
    dom.btnConnect.classList.toggle('connecting', isConnecting);
    dom.btnConnect.disabled = isConnecting;
    if (isConnecting) {
        dom.btnConnect.innerHTML = '<i class="fa-solid fa-spinner"></i> <span>กำลังเชื่อมต่อ…</span>';
        if (dom.badge) dom.badge.classList.add('connecting');
        if (dom.status) dom.status.textContent = 'Connecting…';
    }
}
 
function updateUIConnected(isConnected) {
    if (!dom.status) return;
 
    setConnecting(false);
    if (dom.badge) dom.badge.classList.remove('connecting');
 
    if (isConnected) {
        dom.status.textContent = 'Connected';
        dom.badge.classList.add('on');
        dom.btnConnect.innerHTML = '<i class="fa-brands fa-bluetooth-b"></i> <span>ตัดการเชื่อมต่อ</span>';
        dom.btnConnect.classList.add('connected');
        dom.btnSave.disabled = false;
        if (dom.liveIndicator) dom.liveIndicator.classList.remove('paused');
        if (dom.chartBadge) {
            dom.chartBadge.classList.remove('idle');
            dom.chartBadge.innerHTML = '<i class="fa-solid fa-signal"></i> Live';
        }
        startUptimeTimer();
    } else {
        dom.status.textContent = 'Disconnected';
        dom.badge.classList.remove('on');
        dom.btnConnect.innerHTML = '<i class="fa-brands fa-bluetooth-b"></i> <span>เชื่อมต่อ</span>';
        dom.btnConnect.classList.remove('connected');
        dom.btnSave.disabled = true;
 
        dom.valAir.textContent = '--';
        dom.valHum.textContent = '--';
        dom.valSoil.textContent = '--';
        if (dom.valAirOut) dom.valAirOut.textContent = '--';
        if (dom.valHumOut) dom.valHumOut.textContent = '--';
        if (dom.miniAir) dom.miniAir.textContent = '--';
        if (dom.miniHum) dom.miniHum.textContent = '--';
        if (dom.miniSoil) dom.miniSoil.textContent = '--';
        if (dom.miniAirOut) dom.miniAirOut.textContent = '--';
        if (dom.miniHumOut) dom.miniHumOut.textContent = '--';
        if (dom.deltaTempChip) dom.deltaTempChip.innerHTML = '<i class="fa-solid fa-temperature-half"></i> Δ--°C';
        if (dom.deltaHumChip) dom.deltaHumChip.innerHTML = '<i class="fa-solid fa-droplet"></i> Δ--%';
        setMistState(false);
 
        if (dom.lastUpdated) dom.lastUpdated.textContent = 'รอข้อมูล';
        if (dom.liveIndicator) dom.liveIndicator.classList.add('paused');
        if (dom.chartBadge) {
            dom.chartBadge.classList.add('idle');
            dom.chartBadge.innerHTML = '<i class="fa-regular fa-circle"></i> Idle';
        }
        if (dom.chartEmpty) dom.chartEmpty.classList.remove('hidden');
 
        resetGauges();
        stopUptimeTimer();
    }
}
 
function onDisconnected() {
    console.log('BLE Disconnected');
    updateUIConnected(false);
    showToast('ตัดการเชื่อมต่อ BLE', false);
}
 
// ── TELEMETRY ──
function handleTelemetry(event) {
    const decoder = new TextDecoder('utf-8');
    const jsonString = decoder.decode(event.target.value);
    try {
        applyTelemetry(JSON.parse(jsonString));
    } catch (e) {
        console.error('Error parsing Telemetry JSON:', e);
    }
}

// ใช้ร่วมกันทั้งข้อมูลจริงจาก BLE และข้อมูลจำลองในโหมดทดลอง
function applyTelemetry(data) {
    if (data.tAir !== undefined) setGaugeValue('air', data.tAir);
    if (data.h !== undefined) setGaugeValue('hum', data.h);
    if (data.tSoil !== undefined) setGaugeValue('soil', data.tSoil);
    if (data.tAirOut !== undefined) setGaugeValue('airOut', data.tAirOut);
    if (data.hOut !== undefined) setGaugeValue('humOut', data.hOut);

    if (dom.valAir && data.tAir !== undefined) dom.valAir.textContent = Number(data.tAir).toFixed(1);
    if (dom.valHum && data.h !== undefined) dom.valHum.textContent = Number(data.h).toFixed(1);
    if (dom.valSoil && data.tSoil !== undefined) dom.valSoil.textContent = Number(data.tSoil).toFixed(1);
    if (dom.valAirOut && data.tAirOut !== undefined) dom.valAirOut.textContent = Number(data.tAirOut).toFixed(1);
    if (dom.valHumOut && data.hOut !== undefined) dom.valHumOut.textContent = Number(data.hOut).toFixed(1);

    if (dom.miniAir && data.tAir !== undefined) dom.miniAir.textContent = Number(data.tAir).toFixed(1);
    if (dom.miniHum && data.h !== undefined) dom.miniHum.textContent = Number(data.h).toFixed(1);
    if (dom.miniSoil && data.tSoil !== undefined) dom.miniSoil.textContent = Number(data.tSoil).toFixed(1);
    if (dom.miniAirOut && data.tAirOut !== undefined) dom.miniAirOut.textContent = Number(data.tAirOut).toFixed(1);
    if (dom.miniHumOut && data.hOut !== undefined) dom.miniHumOut.textContent = Number(data.hOut).toFixed(1);

    // ส่วนต่างระหว่างในตู้กับนอกตู้ (แสดงเมื่อมีค่าครบทั้งคู่)
    if (data.tAir !== undefined && data.tAirOut !== undefined && dom.deltaTempChip) {
        const diff = Number(data.tAir) - Number(data.tAirOut);
        const sign = diff > 0 ? '+' : '';
        dom.deltaTempChip.innerHTML = `<i class="fa-solid fa-temperature-half"></i> Δ${sign}${diff.toFixed(1)}°C`;
    }
    if (data.h !== undefined && data.hOut !== undefined && dom.deltaHumChip) {
        const diff = Number(data.h) - Number(data.hOut);
        const sign = diff > 0 ? '+' : '';
        dom.deltaHumChip.innerHTML = `<i class="fa-solid fa-droplet"></i> Δ${sign}${diff.toFixed(1)}%`;
    }

    if (data.mist !== undefined) setMistState(!!data.mist);

    // เก็บสถิติภาพรวม
    if (data.tAir !== undefined && data.h !== undefined) {
        statSumTemp += Number(data.tAir);
        statSumHum += Number(data.h);
        statReadingCount++;
        if (dom.statAvgTemp) dom.statAvgTemp.textContent = (statSumTemp / statReadingCount).toFixed(1);
        if (dom.statAvgHum) dom.statAvgHum.textContent = (statSumHum / statReadingCount).toFixed(1);
    }
    if (data.mist !== undefined) {
        const mistNow = !!data.mist;
        if (mistNow && !statPrevMist) {
            statMistCycleCount++;
            if (dom.statMistCycles) dom.statMistCycles.textContent = statMistCycleCount;
        }
        statPrevMist = mistNow;
    }

    // เก็บค่าล่าสุดไว้ส่งให้ Google Sheet ตามรอบเวลาที่ตั้งไว้
    latestTelemetry = data;

    if (dom.lastUpdated) {
        const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        dom.lastUpdated.textContent = now;
    }

    if (trendChart) {
        const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        timeLabels.push(now);
        tempData.push(data.tAir ?? 0);
        humData.push(data.h ?? 0);
        soilData.push(data.tSoil ?? 0);
        tempOutData.push(data.tAirOut ?? 0);
        humOutData.push(data.hOut ?? 0);

        if (timeLabels.length > MAX_POINTS) {
            timeLabels.shift();
            tempData.shift();
            humData.shift();
            soilData.shift();
            tempOutData.shift();
            humOutData.shift();
        }

        trendChart.data.labels = timeLabels;
        trendChart.data.datasets[0].data = tempData;
        trendChart.data.datasets[1].data = humData;
        trendChart.data.datasets[2].data = soilData;
        trendChart.data.datasets[3].data = tempOutData;
        trendChart.data.datasets[4].data = humOutData;
        trendChart.update('none');

        if (!hasTelemetry && dom.chartEmpty) {
            hasTelemetry = true;
            dom.chartEmpty.classList.add('hidden');
        }
    }
}

// ── DEMO MODE (ข้อมูลจำลอง ไว้พรีวิว UI โดยไม่ต้องมี ESP32 จริง) ──
let demoInterval = null;
let demoState = { tAir: 24, h: 68, tSoil: 22, tAirOut: 31, hOut: 58 };

function clampVal(v, min, max) { return Math.max(min, Math.min(max, v)); }

function generateDemoTick() {
    demoState.tAir = clampVal(demoState.tAir + (Math.random() - 0.5) * 0.8, 18, 33);
    demoState.h = clampVal(demoState.h + (Math.random() - 0.5) * 2.2, 55, 99);
    demoState.tSoil = clampVal(demoState.tSoil + (Math.random() - 0.5) * 0.5, 17, 30);
    // ภายนอกมักร้อนกว่าและแห้งกว่าภายในตู้ที่ควบคุมความชื้นไว้
    demoState.tAirOut = clampVal(demoState.tAirOut + (Math.random() - 0.5) * 1.2, 24, 40);
    demoState.hOut = clampVal(demoState.hOut + (Math.random() - 0.5) * 3.0, 30, 80);

    const target = Number(dom.targetHum ? dom.targetHum.value : 75) || 75;
    applyTelemetry({
        tAir: demoState.tAir,
        h: demoState.h,
        tSoil: demoState.tSoil,
        tAirOut: demoState.tAirOut,
        hOut: demoState.hOut,
        mist: demoState.h < target,
    });
}

function toggleDemoMode() {
    if (demoInterval) {
        stopDemoMode();
        return;
    }
    if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
        showToast('กรุณาตัดการเชื่อมต่ออุปกรณ์จริงก่อนใช้โหมดทดลอง', true);
        return;
    }
    startDemoMode();
}

function startDemoMode() {
    demoInterval = setInterval(generateDemoTick, 1200);
    generateDemoTick();

    if (dom.btnConnect) dom.btnConnect.disabled = true;
    if (dom.btnDemo) dom.btnDemo.classList.add('active');
    if (dom.btnDemoText) dom.btnDemoText.textContent = 'ปิดโหมดทดลอง';
    if (dom.status) dom.status.textContent = 'Demo Mode';
    if (dom.badge) dom.badge.classList.add('on');
    if (dom.liveIndicator) { dom.liveIndicator.classList.remove('paused'); dom.liveIndicator.classList.add('demo'); }
    if (dom.liveIndicatorText) dom.liveIndicatorText.textContent = 'DEMO DATA';
    if (dom.chartBadge) {
        dom.chartBadge.classList.remove('idle');
        dom.chartBadge.classList.add('demo');
        dom.chartBadge.innerHTML = '<i class="fa-solid fa-flask"></i> Demo';
    }
    if (dom.chartEmpty) dom.chartEmpty.classList.add('hidden');
    startUptimeTimer();
    showToast('เปิดโหมดทดลอง — กำลังแสดงข้อมูลจำลอง', false);
}

function stopDemoMode() {
    clearInterval(demoInterval);
    demoInterval = null;

    if (dom.btnDemo) dom.btnDemo.classList.remove('active');
    if (dom.btnDemoText) dom.btnDemoText.textContent = 'โหมดทดลอง';
    if (dom.liveIndicator) dom.liveIndicator.classList.remove('demo');
    if (dom.liveIndicatorText) dom.liveIndicatorText.textContent = 'LIVE DATA';
    if (dom.chartBadge) dom.chartBadge.classList.remove('demo');

    timeLabels = []; tempData = []; humData = []; soilData = []; tempOutData = []; humOutData = []; hasTelemetry = false;
    if (trendChart) {
        trendChart.data.labels = [];
        trendChart.data.datasets.forEach((d) => (d.data = []));
        trendChart.update('none');
    }

    if (dom.btnConnect) dom.btnConnect.disabled = false;
    updateUIConnected(false);
}
 
function setMistState(isOn) {
    if (dom.mistIcon && dom.mistLabel) {
        if (isOn) {
            dom.mistIcon.className = 'mist-icon on fas fa-toggle-on';
            dom.mistLabel.textContent = 'ON';
            dom.mistLabel.className = 'mist-label on';
            if (dom.mistStateText) dom.mistStateText.textContent = 'กำลังพ่นหมอกเพื่อเพิ่มความชื้น';
        } else {
            dom.mistIcon.className = 'mist-icon off fas fa-toggle-off';
            dom.mistLabel.textContent = 'OFF';
            dom.mistLabel.className = 'mist-label off';
            if (dom.mistStateText) dom.mistStateText.textContent = 'ระบบอยู่ในโหมดสแตนด์บาย';
        }
    }
    if (dom.miniMist) {
        dom.miniMist.textContent = isOn ? 'ON' : 'OFF';
        dom.miniMist.classList.toggle('on', isOn);
    }
    if (dom.miniMistText) dom.miniMistText.textContent = isOn ? 'Active' : 'Standby';
}
 
// ── CONFIG ──
function syncTargetDisplay(value) {
    const num = Math.max(0, Math.min(100, Number(value) || 0));
    if (dom.targetPreview) dom.targetPreview.textContent = num.toFixed(num % 1 === 0 ? 0 : 1);
    if (dom.targetBar) dom.targetBar.style.width = num + '%';
}
 
async function readCurrentConfig() {
    if (!configChar) return;
    try {
        const value = await configChar.readValue();
        const decoder = new TextDecoder('utf-8');
        const configStr = decoder.decode(value);
        const config = JSON.parse(configStr);
        if (config.hasOwnProperty('targetHum')) {
            const inputEl = document.getElementById('targetHum');
            if (inputEl) inputEl.value = config.targetHum;
            syncTargetDisplay(config.targetHum);
        }
    } catch (error) {
        console.error('Failed to read config:', error);
    }
}
 
async function sendConfig() {
    if (!configChar) return;
 
    const inputEl = document.getElementById('targetHum');
    const targetHum = parseFloat(inputEl.value);
    if (isNaN(targetHum) || targetHum < 0 || targetHum > 100) {
        showToast('กรุณากรอกค่าความชื้นระหว่าง 0-100', true);
        return;
    }
 
    const configData = { targetHum };
    const jsonString = JSON.stringify(configData);
    const encoder = new TextEncoder();
 
    try {
        await configChar.writeValue(encoder.encode(jsonString));
        syncTargetDisplay(targetHum);
        showToast('บันทึกความชื้นเป้าหมายสำเร็จ! ✓', false);
        console.log('Sent Config:', jsonString);
 
        if (dom.btnSave) {
            const original = dom.btnSave.innerHTML;
            dom.btnSave.classList.add('saved');
            dom.btnSave.innerHTML = '<i class="fa-solid fa-check"></i> บันทึกแล้ว';
            setTimeout(() => {
                dom.btnSave.classList.remove('saved');
                dom.btnSave.innerHTML = original;
            }, 1800);
        }
    } catch (error) {
        console.error('Failed to write config:', error);
        showToast('เกิดข้อผิดพลาด: ' + error.message, true);
    }
}
 
// ── GOOGLE SHEET LOGGING ──
// บันทึกข้อมูลเซนเซอร์ไปยัง Google Sheet ผ่าน Google Apps Script Web App
// วิธีตั้งค่า: ดูไฟล์ google-apps-script.gs ที่มาพร้อมโปรเจกต์นี้
const SHEET_STORAGE_KEY = {
    url: 'mh_sheetUrl',
    enabled: 'mh_sheetEnabled',
    interval: 'mh_sheetInterval',
};

function initSheetLogging() {
    const savedUrl = localStorage.getItem(SHEET_STORAGE_KEY.url) || '';
    const savedEnabled = localStorage.getItem(SHEET_STORAGE_KEY.enabled) === 'true';
    const savedInterval = localStorage.getItem(SHEET_STORAGE_KEY.interval) || '30000';

    if (dom.sheetUrl) {
        dom.sheetUrl.value = savedUrl;
        dom.sheetUrl.addEventListener('change', () => {
            localStorage.setItem(SHEET_STORAGE_KEY.url, dom.sheetUrl.value.trim());
        });
    }
    if (dom.sheetInterval) {
        dom.sheetInterval.value = savedInterval;
        dom.sheetInterval.addEventListener('change', () => {
            localStorage.setItem(SHEET_STORAGE_KEY.interval, dom.sheetInterval.value);
            if (dom.sheetEnable && dom.sheetEnable.checked) startSheetLogInterval();
        });
    }
    if (dom.sheetEnable) {
        dom.sheetEnable.checked = savedEnabled && !!savedUrl;
        if (dom.sheetEnable.checked) {
            startSheetLogInterval();
            setSheetStatus('ok', 'กำลังบันทึกข้อมูลอัตโนมัติ');
        }
    }
}

function toggleSheetLogging() {
    if (!dom.sheetEnable) return;

    if (dom.sheetEnable.checked) {
        const url = (dom.sheetUrl.value || '').trim();
        if (!url) {
            showToast('กรุณากรอกลิงก์ Google Apps Script Web App ก่อนเปิดใช้งาน', true);
            dom.sheetEnable.checked = false;
            return;
        }
        localStorage.setItem(SHEET_STORAGE_KEY.url, url);
        localStorage.setItem(SHEET_STORAGE_KEY.enabled, 'true');
        startSheetLogInterval();
        setSheetStatus('ok', 'เปิดใช้งานการบันทึกอัตโนมัติแล้ว');
        showToast('เปิดการบันทึกข้อมูลลง Google Sheet แล้ว', false);
    } else {
        localStorage.setItem(SHEET_STORAGE_KEY.enabled, 'false');
        stopSheetLogInterval();
        setSheetStatus('', 'ปิดใช้งานการบันทึกอัตโนมัติ');
    }
}

function startSheetLogInterval() {
    stopSheetLogInterval();
    const ms = Number(dom.sheetInterval ? dom.sheetInterval.value : 30000) || 30000;
    sheetLogTimer = setInterval(() => {
        if (latestTelemetry) sendToGoogleSheet(latestTelemetry);
    }, ms);
}

function stopSheetLogInterval() {
    clearInterval(sheetLogTimer);
    sheetLogTimer = null;
}

function setSheetStatus(kind, text) {
    if (!dom.sheetStatus) return;
    dom.sheetStatus.className = 'sheet-status' + (kind ? ' ' + kind : '');
    const icon = kind === 'ok' ? 'fa-solid fa-circle-check' : kind === 'err' ? 'fa-solid fa-circle-exclamation' : 'fa-regular fa-circle';
    dom.sheetStatus.innerHTML = `<i class="${icon}"></i><span>${text}</span>`;
}

// ส่งข้อมูลไปยัง Apps Script ด้วย fetch แบบ no-cors (Apps Script Web App ไม่รองรับ CORS headers
// สำหรับอ่านค่าตอบกลับ จึงส่งแบบ fire-and-forget แล้วให้ผู้ใช้ตรวจสอบผลใน Google Sheet โดยตรง)
async function sendToGoogleSheet(data) {
    const url = (dom.sheetUrl ? dom.sheetUrl.value : '').trim();
    if (!url) return;

    const payload = {
        timestamp: new Date().toISOString(),
        tAir: data.tAir ?? '',
        h: data.h ?? '',
        tSoil: data.tSoil ?? '',
        tAirOut: data.tAirOut ?? '',
        hOut: data.hOut ?? '',
        mist: data.mist ? 'ON' : 'OFF',
    };

    try {
        await fetch(url, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
        });
        const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setSheetStatus('ok', `บันทึกล่าสุด: ${now}`);
        return true;
    } catch (error) {
        console.error('Failed to send data to Google Sheet:', error);
        setSheetStatus('err', 'ส่งข้อมูลไม่สำเร็จ ตรวจสอบลิงก์และอินเทอร์เน็ต');
        return false;
    }
}

async function testSheetConnection() {
    const url = (dom.sheetUrl ? dom.sheetUrl.value : '').trim();
    if (!url) {
        showToast('กรุณากรอกลิงก์ Google Apps Script Web App ก่อน', true);
        return;
    }

    const sample = latestTelemetry || { tAir: 25, h: 75, tSoil: 22, tAirOut: 30, hOut: 60, mist: false };

    if (dom.btnTestSheet) {
        dom.btnTestSheet.disabled = true;
        dom.btnTestSheet.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่ง...';
    }

    const ok = await sendToGoogleSheet(sample);

    if (dom.btnTestSheet) {
        dom.btnTestSheet.disabled = false;
        dom.btnTestSheet.innerHTML = '<i class="fa-solid fa-paper-plane"></i> ทดสอบส่งข้อมูล';
    }

    if (ok) {
        showToast('ส่งข้อมูลทดสอบแล้ว กรุณาตรวจสอบใน Google Sheet ✓', false);
    } else {
        showToast('ส่งข้อมูลทดสอบไม่สำเร็จ ตรวจสอบลิงก์อีกครั้ง', true);
    }
}

// ── TOAST ──
function showToast(message, isError = false) {
    const toast = dom.toast;
    if (!toast) return;
 
    toast.querySelector('.toast-message').textContent = message;
    toast.className = 'toast' + (isError ? ' err' : '');
    toast.classList.add('show');
    if (dom.toastIcon) dom.toastIcon.className = isError ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}