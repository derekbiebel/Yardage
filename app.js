// ---- CONFIG ----
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

function getApiKey() {
    return localStorage.getItem('yardage_api_key');
}

function setApiKey(key) {
    localStorage.setItem('yardage_api_key', key);
}

// ---- STATE ----
let currentUnit = 'ft';
let lastResult = null; // { feet, detail, confidence }
let currentBase64 = null; // stored after photo is taken
let tapTarget = null; // { xPct, yPct } - where user tapped as percentage

// ---- DOM ----
const $ = id => document.getElementById(id);
const cameraInput = $('camera-input');
const preview = $('preview');
const placeholder = $('placeholder');
const loading = $('loading');
const result = $('result');
const distanceValue = $('distance-value');
const distanceUnit = $('distance-unit');
const distanceDetail = $('distance-detail');
const distanceConfidence = $('distance-confidence');

// ---- CAMERA INPUT ----
cameraInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Show preview
    const reader = new FileReader();
    reader.onload = async (ev) => {
        const dataUrl = ev.target.result;
        const resized = await resizeImage(dataUrl, 1024);
        preview.src = resized;
        preview.classList.remove('hidden');
        placeholder.classList.add('hidden');
        result.classList.add('hidden');
        $('tap-pin').classList.add('hidden');
        $('tap-hint').classList.remove('hidden');
        currentBase64 = resized.split(',')[1];
        tapTarget = null;

        // Auto-estimate the main subject right away
        loading.classList.remove('hidden');
        try {
            await estimateDistance(currentBase64, 'image/jpeg', null);
        } catch (err) {
            showError(err.message || 'Something went wrong');
        } finally {
            loading.classList.add('hidden');
        }
    };
    reader.readAsDataURL(file);
});

// ---- TAP TO TARGET ----
$('photo-area').addEventListener('click', async (e) => {
    if (!currentBase64 || !preview.src) return;
    // Don't trigger on the camera button
    if (e.target === cameraInput || e.target.closest('#snap-btn')) return;

    const rect = preview.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const xPct = Math.round((x / rect.width) * 100);
    const yPct = Math.round((y / rect.height) * 100);

    // Show pin
    const pin = $('tap-pin');
    pin.style.left = (x / $('photo-area').offsetWidth * 100) + '%';
    pin.style.top = (y / $('photo-area').offsetHeight * 100) + '%';
    pin.classList.remove('hidden');
    $('tap-hint').classList.add('hidden');

    tapTarget = { xPct, yPct };

    // Estimate for tapped spot
    loading.classList.remove('hidden');
    result.classList.add('hidden');
    try {
        await estimateDistance(currentBase64, 'image/jpeg', tapTarget);
    } catch (err) {
        showError(err.message || 'Something went wrong');
    } finally {
        loading.classList.add('hidden');
    }
});

// ---- IMAGE RESIZE ----
// Resize image to max dimension to keep API requests small
function resizeImage(dataUrl, maxDim) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let w = img.width;
            let h = img.height;
            if (w > maxDim || h > maxDim) {
                if (w > h) {
                    h = Math.round(h * maxDim / w);
                    w = maxDim;
                } else {
                    w = Math.round(w * maxDim / h);
                    h = maxDim;
                }
            }
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            resolve(c.toDataURL('image/jpeg', 0.8));
        };
        img.src = dataUrl;
    });
}

// ---- AI DISTANCE ESTIMATION ----
async function estimateDistance(base64Image, mediaType, target) {
    let prompt;
    if (target) {
        prompt = `You are a distance estimation tool. The user tapped a specific point on this photo at approximately ${target.xPct}% from the left and ${target.yPct}% from the top. Estimate how far away the object/surface at THAT specific tapped location is from the camera.

Rules:
- Focus on what is at that specific point in the image (${target.xPct}% from left, ${target.yPct}% from top)
- Give your best estimate in FEET as a single number
- Identify what is at the tapped location
- Explain briefly how you estimated
- Rate your confidence: high, medium, or low
- Be direct and concise

Respond in EXACTLY this JSON format, nothing else:
{
  "feet": 25,
  "object": "the fence post",
  "detail": "The tapped point is on a fence post. Based on typical fence post height of 4ft and its apparent size in frame.",
  "confidence": "medium"
}`;
    } else {
        prompt = `You are a distance estimation tool. Look at this photo and estimate how far away the main subject/object is from the camera.

Rules:
- Give your best estimate in FEET as a single number
- Identify what the main object is
- Explain briefly how you estimated (object size, perspective, etc.)
- Rate your confidence: high, medium, or low
- Be direct and concise

Respond in EXACTLY this JSON format, nothing else:
{
  "feet": 25,
  "object": "oak tree",
  "detail": "Based on the apparent size of the tree trunk and canopy relative to the frame, and typical oak tree dimensions of 40-60ft tall.",
  "confidence": "medium"
}`;
    }

    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No API key set');

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 300,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mediaType,
                            data: base64Image,
                        },
                    },
                    {
                        type: 'text',
                        text: prompt,
                    },
                ],
            }],
        }),
    });

    if (!response.ok) {
        let errMsg;
        try {
            const err = await response.json();
            errMsg = err.error?.message || JSON.stringify(err);
        } catch (e) {
            errMsg = response.status + ' ' + response.statusText;
        }
        throw new Error(errMsg);
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    // Parse JSON from response
    let parsed;
    try {
        // Handle case where response might have markdown code fences
        const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        throw new Error('Could not parse AI response');
    }

    lastResult = {
        feet: parsed.feet,
        object: parsed.object,
        detail: parsed.detail,
        confidence: parsed.confidence,
    };

    showResult();
}

// ---- DISPLAY RESULT ----
function showResult() {
    if (!lastResult) return;

    result.classList.remove('hidden');

    const converted = convertDistance(lastResult.feet, currentUnit);
    distanceValue.textContent = converted.value;
    distanceUnit.textContent = converted.unit;

    distanceDetail.textContent = lastResult.detail;
    distanceDetail.classList.remove('error-text');

    const confLabels = {
        high: '🎯 High confidence',
        medium: '🤔 Medium confidence — take with a grain of salt',
        low: '🤷 Low confidence — rough guess',
    };
    distanceConfidence.textContent = confLabels[lastResult.confidence] || lastResult.confidence;
}

function convertDistance(feet, unit) {
    switch (unit) {
        case 'ft':
            if (feet >= 1000) return { value: numberFormat(feet), unit: 'ft' };
            if (feet >= 100) return { value: Math.round(feet), unit: 'ft' };
            if (feet >= 10) return { value: Math.round(feet), unit: 'ft' };
            return { value: Math.round(feet * 10) / 10, unit: 'ft' };
        case 'yd':
            const yards = feet / 3;
            if (yards >= 100) return { value: Math.round(yards), unit: 'yd' };
            return { value: Math.round(yards * 10) / 10, unit: 'yd' };
        case 'm':
            const meters = feet * 0.3048;
            if (meters >= 100) return { value: Math.round(meters), unit: 'm' };
            return { value: Math.round(meters * 10) / 10, unit: 'm' };
        default:
            return { value: Math.round(feet), unit: 'ft' };
    }
}

function numberFormat(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return Math.round(n).toString();
}

function showError(msg) {
    result.classList.remove('hidden');
    distanceValue.textContent = '--';
    distanceUnit.textContent = '';
    distanceDetail.textContent = msg;
    distanceDetail.classList.add('error-text');
    distanceConfidence.textContent = '';
}

// ---- API KEY SETUP ----
function checkApiKey() {
    if (!getApiKey()) {
        $('key-setup').classList.remove('hidden');
    }
}

$('key-save').addEventListener('click', () => {
    const key = $('key-input').value.trim();
    if (key && key.startsWith('sk-')) {
        setApiKey(key);
        $('key-setup').classList.add('hidden');
    } else {
        $('key-input').style.borderColor = '#E07060';
    }
});

checkApiKey();

// ---- UNIT TOGGLE ----
document.querySelectorAll('.unit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.unit-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentUnit = btn.dataset.unit;
        if (lastResult) showResult();
    });
});
